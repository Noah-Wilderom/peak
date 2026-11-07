package peak

import (
	"bufio"
	"encoding/json"
	"math"
	"net"
	"os"
	"runtime"
	"strings"
	"testing"
	"time"
)

var sink [][]byte

//go:noinline
func burn(until time.Time) int {
	x := 0
	for time.Now().Before(until) {
		for i := 0; i < 1000; i++ {
			x += i * i
		}
	}
	return x
}

//go:noinline
func allocateLots() {
	for i := 0; i < 2000; i++ {
		sink = append(sink, make([]byte, 64*1024))
	}
}

func hasFrame(f *Frame, part string) bool {
	if strings.Contains(f.Name, part) {
		return true
	}
	for _, c := range f.Children {
		if hasFrame(c, part) {
			return true
		}
	}
	return false
}

func total(f *Frame) float64 {
	sum := f.Self
	for _, c := range f.Children {
		sum += total(c)
	}
	return sum
}

func TestStartDoesNothingOutsidePeak(t *testing.T) {
	os.Unsetenv("PEAK_AGENT_ADDR")
	Start()()
}

func TestStartSurvivesAnUnreachableApp(t *testing.T) {
	t.Setenv("PEAK_AGENT_ADDR", "127.0.0.1:1")
	t.Setenv("PEAK_AGENT_TOKEN", "x")
	Start()()
}

func TestCPUProfileFindsTheHotFunction(t *testing.T) {
	done := make(chan int)
	go func() { done <- burn(time.Now().Add(1500 * time.Millisecond)) }()
	got, err := cpuProfile(time.Second)
	<-done
	if err != nil {
		t.Fatal(err)
	}
	if got.Sampling != "pprof" || got.DurationMs < 900 {
		t.Fatalf("sampling %q, duration %v", got.Sampling, got.DurationMs)
	}
	if !hasFrame(got.Root, "go.burn") {
		t.Fatal("no burn in the profile")
	}
	// A whole second of one busy goroutine, in milliseconds rather than nanoseconds.
	if ms := total(got.Root); ms < 300 || ms > 5000 {
		t.Fatalf("sampled %v ms over a second", ms)
	}
}

func TestSnapshotFindsTheAllocatingFunction(t *testing.T) {
	old := runtime.MemProfileRate
	runtime.MemProfileRate = 4096
	defer func() { runtime.MemProfileRate = old }()
	allocateLots()
	snap := snapshot()
	sink = nil
	if snap.HeapUsed == 0 || !hasFrame(snap.Sites, "allocateLots") {
		t.Fatalf("heap %d, sites missing allocateLots", snap.HeapUsed)
	}
	found := false
	for _, e := range snap.Entries {
		if strings.Contains(e.Name, "allocateLots") && e.Shallow > 10*1024*1024 {
			found = true
		}
	}
	if !found {
		t.Fatalf("entries: %+v", snap.Entries)
	}
}

func TestParseRejectsGarbage(t *testing.T) {
	if _, err := parseCPUProfile([]byte("not gzip")); err == nil {
		t.Fatal("garbage parsed")
	}
	var p profile
	for _, bad := range [][]byte{{0x80}, {0x08}, {0x09, 1}, {0x0a, 5, 1}, {0x0d, 1}, {0x0b}} {
		if err := p.parse(bad); err == nil {
			t.Fatalf("% x parsed", bad)
		}
	}
}

func TestPercentile(t *testing.T) {
	buckets := []float64{0, 0.001, 0.002, math.Inf(1)}
	if _, ok := percentile([]uint64{0, 0, 0}, nil, buckets, 0.99); ok {
		t.Fatal("nothing scheduled must read as no measurement, not zero")
	}
	if ms, ok := percentile([]uint64{100, 0, 0}, nil, buckets, 0.99); !ok || ms != 1 {
		t.Fatalf("got %v %v", ms, ok)
	}
	// Only what's new since the last read counts.
	if ms, ok := percentile([]uint64{100, 5, 0}, []uint64{100, 0, 0}, buckets, 0.99); !ok || ms != 2 {
		t.Fatalf("got %v %v", ms, ok)
	}
	// The last bucket has no upper edge.
	if ms, ok := percentile([]uint64{0, 0, 1}, nil, buckets, 0.99); !ok || ms != 2 {
		t.Fatalf("got %v %v", ms, ok)
	}
}

func TestCollectionsAttributesFreedBytesOnce(t *testing.T) {
	var prev, m runtime.MemStats
	m.NumGC = 2
	m.PauseNs[0], m.PauseNs[1] = 1_000_000, 2_000_000
	m.TotalAlloc, m.HeapAlloc = 1000, 400
	got := collections(&prev, &m)
	if len(got) != 2 || got[0]["freed"] != 0.0 || got[1]["freed"] != 600.0 || got[1]["pauseMs"] != 2.0 {
		t.Fatalf("%+v", got)
	}
}

// The real protocol against a stand-in hub.
func TestSpeaksTheProtocol(t *testing.T) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	t.Setenv("PEAK_AGENT_ADDR", l.Addr().String())
	t.Setenv("PEAK_AGENT_TOKEN", "tok")
	stop := Start()
	defer stop()
	c, err := l.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	c.SetDeadline(time.Now().Add(20 * time.Second))
	r := bufio.NewReader(c)
	read := func() map[string]any {
		line, err := r.ReadBytes('\n')
		if err != nil {
			t.Fatal(err)
		}
		var v map[string]any
		if err := json.Unmarshal(line, &v); err != nil {
			t.Fatal(err)
		}
		return v
	}
	first := read()
	info := first["agent"].(map[string]any)
	if first["type"] != "hello" || first["token"] != "tok" || first["runtime"] != "go" || info["agentVersion"] != Version {
		t.Fatalf("%+v", first)
	}
	seen := map[string]bool{}
	c.Write([]byte(`{"cmd":"gc","reqId":1}` + "\n" + `{"cmd":"nope","reqId":2}` + "\n" + `{"cmd":"snapshot","reqId":3}` + "\n"))
	replies := map[float64]map[string]any{}
	for len(replies) < 3 || !seen["heap"] || !seen["gauges"] {
		v := read()
		kind := v["type"].(string)
		seen[kind] = true
		if kind == "reply" {
			replies[v["reqId"].(float64)] = v
		}
	}
	if replies[1]["ok"] != true || replies[2]["ok"] != false || replies[3]["data"] == nil {
		t.Fatalf("%+v", replies)
	}
}
