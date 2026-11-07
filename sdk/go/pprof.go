package peak

import (
	"bytes"
	"compress/gzip"
	"errors"
	"io"
)

// parseCPUProfile turns runtime/pprof's output, a gzipped protocol buffer, into a call tree in
// milliseconds. Only the fields this needs are read, to keep the standard library the only
// dependency. Field numbers are from pprof's profile.proto.
func parseCPUProfile(data []byte) (*Frame, error) {
	zr, err := gzip.NewReader(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(zr)
	if err != nil {
		return nil, err
	}
	var p profile
	if err := p.parse(raw); err != nil {
		return nil, err
	}
	return p.tree(), nil
}

type sample struct {
	locations []uint64
	values    []int64
}

type line struct{ function, number uint64 }

type function struct{ name, file uint64 }

type valueType struct{ kind, unit uint64 }

type profile struct {
	types     []valueType
	samples   []sample
	locations map[uint64][]line
	functions map[uint64]function
	strings   []string
}

func (p *profile) parse(b []byte) error {
	p.locations = map[uint64][]line{}
	p.functions = map[uint64]function{}
	return fields(b, func(num uint64, v uint64, body []byte) error {
		var err error
		switch num {
		case 1:
			var t valueType
			err = fields(body, func(n, v uint64, _ []byte) error {
				if n == 1 {
					t.kind = v
				} else if n == 2 {
					t.unit = v
				}
				return nil
			})
			p.types = append(p.types, t)
		case 2:
			err = p.parseSample(body)
		case 4:
			err = p.parseLocation(body)
		case 5:
			var id uint64
			var f function
			err = fields(body, func(n, v uint64, _ []byte) error {
				switch n {
				case 1:
					id = v
				case 2:
					f.name = v
				case 4:
					f.file = v
				}
				return nil
			})
			p.functions[id] = f
		case 6:
			p.strings = append(p.strings, string(body))
		}
		return err
	})
}

func (p *profile) parseSample(body []byte) error {
	var s sample
	err := fields(body, func(n, v uint64, packed []byte) error {
		switch n {
		case 1:
			if packed == nil {
				s.locations = append(s.locations, v)
				return nil
			}
			return varints(packed, func(x uint64) { s.locations = append(s.locations, x) })
		case 2:
			if packed == nil {
				s.values = append(s.values, int64(v))
				return nil
			}
			return varints(packed, func(x uint64) { s.values = append(s.values, int64(x)) })
		}
		return nil
	})
	p.samples = append(p.samples, s)
	return err
}

func (p *profile) parseLocation(body []byte) error {
	var id uint64
	var lines []line
	err := fields(body, func(n, v uint64, sub []byte) error {
		switch n {
		case 1:
			id = v
		case 4:
			var l line
			if err := fields(sub, func(n, v uint64, _ []byte) error {
				if n == 1 {
					l.function = v
				} else if n == 2 {
					l.number = v
				}
				return nil
			}); err != nil {
				return err
			}
			lines = append(lines, l)
		}
		return nil
	})
	p.locations[id] = lines
	return err
}

func (p *profile) str(i uint64) string {
	if i < uint64(len(p.strings)) {
		return p.strings[i]
	}
	return ""
}

// timeIndex finds which sample value is time, and what one unit of it is in milliseconds.
func (p *profile) timeIndex() (int, float64) {
	for i, t := range p.types {
		if p.str(t.kind) == "cpu" {
			switch p.str(t.unit) {
			case "nanoseconds":
				return i, 1e-6
			case "microseconds":
				return i, 1e-3
			case "milliseconds":
				return i, 1
			}
		}
	}
	return len(p.types) - 1, 1e-6
}

func (p *profile) tree() *Frame {
	root := &Frame{Name: "(root)", Children: []*Frame{}}
	idx, toMs := p.timeIndex()
	for _, s := range p.samples {
		if idx < 0 || idx >= len(s.values) {
			continue
		}
		node := root
		// Locations run leaf first, and so do the inlined lines within each.
		for i := len(s.locations) - 1; i >= 0; i-- {
			lines := p.locations[s.locations[i]]
			for j := len(lines) - 1; j >= 0; j-- {
				fn := p.functions[lines[j].function]
				node = node.child(p.str(fn.name), fileLine(p.str(fn.file), lines[j].number))
			}
		}
		node.Self += float64(s.values[idx]) * toMs
	}
	return root
}

func fileLine(file string, number uint64) string {
	if file == "" {
		return ""
	}
	return file + ":" + itoa(number)
}

func itoa(n uint64) string {
	if n == 0 {
		return "0"
	}
	var b [20]byte
	i := len(b)
	for n > 0 {
		i--
		b[i] = byte('0' + n%10)
		n /= 10
	}
	return string(b[i:])
}

var errTruncated = errors.New("truncated CPU profile")

func varint(b []byte) (uint64, int) {
	var x uint64
	for i, c := range b {
		if i == 10 {
			return 0, 0
		}
		x |= uint64(c&0x7f) << (7 * uint(i))
		if c < 0x80 {
			return x, i + 1
		}
	}
	return 0, 0
}

// fields walks a protocol buffer message. `v` is set for varints, `body` for length-delimited
// fields. Everything else is skipped.
func fields(b []byte, visit func(num, v uint64, body []byte) error) error {
	for len(b) > 0 {
		key, n := varint(b)
		if n == 0 {
			return errTruncated
		}
		b = b[n:]
		num, wire := key>>3, key&7
		switch wire {
		case 0:
			v, n := varint(b)
			if n == 0 {
				return errTruncated
			}
			b = b[n:]
			if err := visit(num, v, nil); err != nil {
				return err
			}
		case 1:
			if len(b) < 8 {
				return errTruncated
			}
			b = b[8:]
		case 2:
			l, n := varint(b)
			if n == 0 || uint64(len(b)-n) < l {
				return errTruncated
			}
			body := b[n : n+int(l)]
			if body == nil {
				body = []byte{}
			}
			b = b[n+int(l):]
			if err := visit(num, 0, body); err != nil {
				return err
			}
		case 5:
			if len(b) < 4 {
				return errTruncated
			}
			b = b[4:]
		default:
			return errTruncated
		}
	}
	return nil
}

func varints(b []byte, visit func(uint64)) error {
	for len(b) > 0 {
		x, n := varint(b)
		if n == 0 {
			return errTruncated
		}
		visit(x)
		b = b[n:]
	}
	return nil
}
