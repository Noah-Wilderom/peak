// Package peak reports a Go program's runtime to the Peak app: heap, garbage collections,
// scheduler latency, CPU profiles and heap profiles.
//
// A compiled Go program can't have anything injected into it, so it opts in:
//
//	import _ "github.com/Noah-Wilderom/peak/sdk/go/auto"
//
// or call Start yourself. Run the program with `peak run -- ./yourprogram` or from Peak's
// Capture page. Without those, Start returns straight away and costs nothing, so it's safe
// to leave in. Standard library only.
package peak

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"net"
	"os"
	"runtime"
	"runtime/metrics"
	"runtime/pprof"
	"sort"
	"strings"
	"sync"
	"time"
)

// Version is this agent's version. Peak's release tooling keeps it in step with the app.
const Version = "0.1.1"

const tick = 500 * time.Millisecond
const schedLatency = "/sched/latencies:seconds"

// Start connects to Peak if this process was started by it, and returns a function that
// disconnects. It never fails a program: if Peak can't be reached, it does nothing.
func Start() (stop func()) {
	addr, token := os.Getenv("PEAK_AGENT_ADDR"), os.Getenv("PEAK_AGENT_TOKEN")
	if addr == "" || token == "" {
		return func() {}
	}
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		return func() {}
	}
	a := &agent{conn: conn, done: make(chan struct{})}
	return a.serve(token)
}

type agent struct {
	conn    net.Conn
	mu      sync.Mutex
	done    chan struct{}
	closing sync.Once
	wg      sync.WaitGroup
}

func (a *agent) close() {
	a.closing.Do(func() {
		close(a.done)
		a.conn.Close()
	})
}

func (a *agent) send(v any) {
	a.mu.Lock()
	defer a.mu.Unlock()
	// A closed or unresponsive app must not hold the program up.
	a.conn.SetWriteDeadline(time.Now().Add(time.Second))
	if err := json.NewEncoder(a.conn).Encode(v); err != nil {
		a.close()
	}
}

func hello(token string) map[string]any {
	return map[string]any{
		"type": "hello", "token": token, "pid": os.Getpid(), "runtime": "go",
		"agent": map[string]any{
			"runtimeVersion": strings.TrimPrefix(runtime.Version(), "go"),
			"agentVersion":   Version,
			"capabilities":   []string{"heap", "gc", "lag", "cpu", "snapshot", "forcegc"},
			"notes": map[string]string{
				"lag":      "p99 time goroutines waited to be scheduled",
				"cpu":      "On-CPU time from runtime/pprof, across all goroutines. Sleeping and blocked goroutines don't appear.",
				"snapshot": "Sampled allocation sites from the runtime's heap profile. Go has no type names or retained sizes here, so entries are grouped by allocating function, and sizes are estimates scaled from samples.",
				"freed":    "Estimated from allocation counters between samples.",
			},
		},
	}
}

func (a *agent) serve(token string) func() {
	a.send(hello(token))
	a.wg.Add(2)
	go a.report()
	go a.listen()
	return func() {
		a.close()
		a.wg.Wait()
	}
}

// report sends heap figures, collections and scheduler latency at each tick.
func (a *agent) report() {
	defer a.wg.Done()
	ticker := time.NewTicker(tick)
	defer ticker.Stop()
	var prev runtime.MemStats
	runtime.ReadMemStats(&prev)
	lag := newLagReader()
	for {
		select {
		case <-a.done:
			return
		case <-ticker.C:
		}
		var m runtime.MemStats
		runtime.ReadMemStats(&m)
		heap := map[string]any{"type": "heap", "heapUsed": m.HeapAlloc, "heapTotal": m.HeapSys, "external": 0}
		if ms, ok := lag.read(); ok {
			heap["loopLag"] = ms
		}
		a.send(heap)
		for _, gc := range collections(&prev, &m) {
			a.send(gc)
		}
		a.send(map[string]any{"type": "gauges", "values": []map[string]any{
			{"name": "Goroutines", "value": runtime.NumGoroutine(), "unit": "count"},
			{"name": "Time in GC", "value": m.GCCPUFraction * 100, "unit": "percent"},
			{"name": "Live objects", "value": m.HeapObjects, "unit": "count"},
		}})
		prev = m
	}
}

// collections describes the GC cycles finished between two readings. Go's collector isn't
// generational, so each is "major". Freed bytes can only be estimated for the whole interval,
// and they go on its last cycle so they aren't counted twice.
func collections(prev, m *runtime.MemStats) []map[string]any {
	size := uint32(len(m.PauseNs))
	count := m.NumGC - prev.NumGC
	if count > size {
		count = size
	}
	freed := float64(m.TotalAlloc-m.HeapAlloc) - float64(prev.TotalAlloc-prev.HeapAlloc)
	events := make([]map[string]any, 0, count)
	for i := count; i > 0; i-- {
		idx := (m.NumGC - i) % size
		bytes := 0.0
		if i == 1 {
			bytes = math.Max(0, freed)
		}
		events = append(events, map[string]any{
			"type": "gc", "kind": "major", "pauseMs": float64(m.PauseNs[idx]) / 1e6,
			"freed": bytes, "t": m.PauseEnd[idx] / 1e6,
		})
	}
	return events
}

type lagReader struct {
	sample []metrics.Sample
	last   []uint64
}

func newLagReader() *lagReader {
	return &lagReader{sample: []metrics.Sample{{Name: schedLatency}}}
}

// read gives the p99 scheduling wait since the last read, in milliseconds. No goroutine
// having been scheduled means there's nothing to report, which isn't the same as zero.
func (l *lagReader) read() (float64, bool) {
	metrics.Read(l.sample)
	if l.sample[0].Value.Kind() != metrics.KindFloat64Histogram {
		return 0, false
	}
	h := l.sample[0].Value.Float64Histogram()
	ms, ok := percentile(h.Counts, l.last, h.Buckets, 0.99)
	l.last = append(l.last[:0], h.Counts...)
	return ms, ok
}

// percentile finds a quantile of the counts added since last, as the upper edge of its bucket.
func percentile(counts, last []uint64, buckets []float64, q float64) (float64, bool) {
	total := uint64(0)
	deltas := make([]uint64, len(counts))
	for i, c := range counts {
		if i < len(last) {
			c -= last[i]
		}
		deltas[i] = c
		total += c
	}
	if total == 0 {
		return 0, false
	}
	target := uint64(math.Ceil(float64(total) * q))
	seen := uint64(0)
	for i, d := range deltas {
		seen += d
		if seen >= target {
			edge := buckets[i+1]
			if math.IsInf(edge, 1) {
				edge = buckets[i]
			}
			return edge * 1000, true
		}
	}
	return 0, false
}

type request struct {
	Cmd   string `json:"cmd"`
	ReqID uint64 `json:"reqId"`
	Ms    uint64 `json:"ms"`
}

func (a *agent) listen() {
	defer a.wg.Done()
	defer a.close()
	lines := bufio.NewScanner(a.conn)
	lines.Buffer(make([]byte, 64*1024), 16*1024*1024)
	for lines.Scan() {
		var req request
		if json.Unmarshal(lines.Bytes(), &req) != nil {
			continue
		}
		// One at a time would hold up a heap request behind a long CPU profile.
		go a.answer(req)
	}
}

func (a *agent) answer(req request) {
	reply := map[string]any{"type": "reply", "reqId": req.ReqID, "ok": true}
	data, err := run(req)
	if err != nil {
		reply["ok"] = false
		reply["error"] = err.Error()
	} else if data != nil {
		reply["data"] = data
	}
	a.send(reply)
}

func run(req request) (any, error) {
	switch req.Cmd {
	case "snapshot":
		return snapshot(), nil
	case "gc":
		runtime.GC()
		return nil, nil
	case "cpuprofile":
		return cpuProfile(time.Duration(req.Ms) * time.Millisecond)
	}
	return nil, fmt.Errorf("unknown command: %s", req.Cmd)
}

// Frame is a node of a call tree. Self is bytes in a heap profile, milliseconds in a CPU one.
type Frame struct {
	Name     string   `json:"name"`
	File     string   `json:"file,omitempty"`
	Self     float64  `json:"self"`
	Children []*Frame `json:"children"`
}

func (f *Frame) child(name, file string) *Frame {
	for _, c := range f.Children {
		if c.Name == name && c.File == file {
			return c
		}
	}
	c := &Frame{Name: name, File: file, Children: []*Frame{}}
	f.Children = append(f.Children, c)
	return c
}

type cpuResult struct {
	DurationMs float64 `json:"durationMs"`
	Sampling   string  `json:"sampling"`
	Root       *Frame  `json:"root"`
}

func cpuProfile(d time.Duration) (*cpuResult, error) {
	if d <= 0 {
		d = time.Second
	}
	var buf bytes.Buffer
	if err := pprof.StartCPUProfile(&buf); err != nil {
		return nil, errors.New("this program is already recording a CPU profile: " + err.Error())
	}
	began := time.Now()
	time.Sleep(d)
	pprof.StopCPUProfile()
	took := time.Since(began)
	root, err := parseCPUProfile(buf.Bytes())
	if err != nil {
		return nil, err
	}
	return &cpuResult{DurationMs: float64(took) / float64(time.Millisecond), Sampling: "pprof", Root: root}, nil
}

type heapEntry struct {
	Name     string  `json:"name"`
	Count    float64 `json:"count"`
	Shallow  float64 `json:"shallow"`
	Retained float64 `json:"retained"`
}

type heapSnapshot struct {
	HeapUsed uint64      `json:"heapUsed"`
	Entries  []heapEntry `json:"entries"`
	Sites    *Frame      `json:"sites"`
}

func snapshot() heapSnapshot {
	// The heap profile lags by up to two collections; finish both before reading it.
	runtime.GC()
	runtime.GC()
	n, _ := runtime.MemProfile(nil, false)
	var records []runtime.MemProfileRecord
	for {
		records = make([]runtime.MemProfileRecord, n+50)
		var ok bool
		n, ok = runtime.MemProfile(records, false)
		if ok {
			records = records[:n]
			break
		}
	}
	result := summarize(records, runtime.MemProfileRate)
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	result.HeapUsed = m.HeapAlloc
	return result
}

func isRuntimeFrame(name string) bool {
	return strings.HasPrefix(name, "runtime.") || strings.HasPrefix(name, "internal/runtime/")
}

// summarize groups sampled in-use bytes by allocating function, scaling samples with the
// runtime's Poisson correction, as pprof does.
func summarize(records []runtime.MemProfileRecord, rate int) heapSnapshot {
	snap := heapSnapshot{Entries: []heapEntry{}, Sites: &Frame{Name: "(root)", Children: []*Frame{}}}
	groups := map[string]*heapEntry{}
	for _, record := range records {
		count, size := float64(record.InUseObjects()), float64(record.InUseBytes())
		if count <= 0 || size <= 0 {
			continue
		}
		if rate > 1 {
			scale := 1 / (1 - math.Exp(-(size/count)/float64(rate)))
			count, size = count*scale, size*scale
		}
		var stack []runtime.Frame
		frames := runtime.CallersFrames(record.Stack())
		for {
			frame, more := frames.Next()
			if frame.Function != "" {
				stack = append(stack, frame)
			}
			if !more {
				break
			}
		}
		name := "(unknown allocation)"
		if len(stack) > 0 {
			name = stack[0].Function
		}
		// Recent Go puts mallocgc and friends first. Group by the first caller outside the
		// runtime, so independent allocation sites stay apart.
		for _, frame := range stack {
			if !isRuntimeFrame(frame.Function) {
				name = frame.Function
				break
			}
		}
		entry := groups[name]
		if entry == nil {
			entry = &heapEntry{Name: name}
			groups[name] = entry
		}
		entry.Count += count
		entry.Shallow += size
		entry.Retained += size
		node := snap.Sites
		for i := len(stack) - 1; i >= 0; i-- {
			node = node.child(stack[i].Function, fmt.Sprintf("%s:%d", stack[i].File, stack[i].Line))
		}
		node.Self += size
	}
	for _, entry := range groups {
		snap.Entries = append(snap.Entries, *entry)
	}
	sort.Slice(snap.Entries, func(i, j int) bool { return snap.Entries[i].Retained > snap.Entries[j].Retained })
	return snap
}
