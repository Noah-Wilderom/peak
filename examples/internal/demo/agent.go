package demo

import (
	"bufio"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net"
	"os"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"
)

// This is a demo agent compiled into these examples, not automatic Go injection.
// It uses the same JSON-lines protocol as Peak's Node and Python agents.
func startAgent() func() {
	addr, token := os.Getenv("PEAK_AGENT_ADDR"), os.Getenv("PEAK_AGENT_TOKEN")
	if addr == "" || token == "" {
		fmt.Println("Peak agent inactive; use peak run or launch this binary from Peak to enable snapshots")
		return func() {}
	}
	conn, err := net.DialTimeout("tcp", addr, 2*time.Second)
	if err != nil {
		log.Printf("Peak agent unavailable: %v", err)
		return func() {}
	}
	return serveAgent(conn, token)
}

func serveAgent(conn net.Conn, token string) func() {
	var mu sync.Mutex
	done := make(chan struct{})
	var once sync.Once
	closeConn := func() {
		once.Do(func() {
			close(done)
			conn.Close()
		})
	}
	send := func(v any) {
		mu.Lock()
		defer mu.Unlock()
		// A closed or unresponsive app must not keep the workload alive.
		conn.SetWriteDeadline(time.Now().Add(time.Second))
		if err := json.NewEncoder(conn).Encode(v); err != nil {
			closeConn()
		}
	}
	send(map[string]any{"type": "hello", "token": token, "pid": os.Getpid(), "runtime": "go"})

	var baseline runtime.MemStats
	runtime.ReadMemStats(&baseline)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		ticker := time.NewTicker(500 * time.Millisecond)
		defer ticker.Stop()
		prev := baseline
		for {
			select {
			case <-done:
				return
			case <-ticker.C:
				var m runtime.MemStats
				runtime.ReadMemStats(&m)
				send(map[string]any{"type": "heap", "heapUsed": m.HeapAlloc, "heapTotal": m.HeapSys, "external": 0})
				// Go GC is non-generational; report completed cycles as major.
				// Freed bytes are estimated over the polling interval. Attribute
				// the total to its final GC event rather than counting it twice.
				freed := float64(m.TotalAlloc-m.HeapAlloc) - float64(prev.TotalAlloc-prev.HeapAlloc)
				count := min(m.NumGC-prev.NumGC, uint32(len(m.PauseNs)))
				for i := count; i > 0; i-- {
					idx := (m.NumGC - i) % uint32(len(m.PauseNs))
					bytes := float64(0)
					if i == 1 {
						bytes = math.Max(0, freed)
					}
					send(map[string]any{
						"type": "gc", "kind": "major", "pauseMs": float64(m.PauseNs[idx]) / 1e6,
						"freed": bytes, "t": m.PauseEnd[idx] / 1e6,
					})
				}
				prev = m
			}
		}
	}()
	go func() {
		defer wg.Done()
		defer closeConn()
		lines := bufio.NewScanner(conn)
		for lines.Scan() {
			var req struct {
				Cmd   string `json:"cmd"`
				ReqID uint64 `json:"reqId"`
			}
			if json.Unmarshal(lines.Bytes(), &req) != nil {
				continue
			}
			reply := map[string]any{"type": "reply", "reqId": req.ReqID, "ok": true}
			switch req.Cmd {
			case "snapshot":
				reply["data"] = snapshot()
			case "gc":
				runtime.GC()
			default:
				reply["ok"] = false
				reply["error"] = "unknown command: " + req.Cmd
			}
			send(reply)
		}
	}()
	fmt.Println("Peak agent connected: live heap, GC events, snapshots, and Collect garbage enabled")
	return func() {
		closeConn()
		wg.Wait()
	}
}

type heapEntry struct {
	Name     string  `json:"name"`
	Count    float64 `json:"count"`
	Shallow  float64 `json:"shallow"`
	Retained float64 `json:"retained"`
}

type allocFrame struct {
	Name     string        `json:"name"`
	File     string        `json:"file,omitempty"`
	Self     float64       `json:"self"`
	Children []*allocFrame `json:"children"`
}

type heapSnapshot struct {
	HeapUsed uint64      `json:"heapUsed"`
	Entries  []heapEntry `json:"entries"`
	Sites    allocFrame  `json:"sites"`
}

func snapshot() heapSnapshot {
	// MemProfile may lag by two GC cycles; finish both before reading it.
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

// Go's public heap profile has allocation stacks, not constructor types or
// dominator retained sizes. Group sampled in-use bytes by allocating function.
// Scale samples using the runtime's Poisson sampling correction, as pprof does.
func summarize(records []runtime.MemProfileRecord, rate int) heapSnapshot {
	snap := heapSnapshot{Entries: []heapEntry{}, Sites: allocFrame{Name: "(root)", Children: []*allocFrame{}}}
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
		frames := runtime.CallersFrames(record.Stack())
		var stack []runtime.Frame
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
		// Go 1.27 includes mallocgc/makeslice frames before the allocating
		// function. Keep them in the tree, but group by the first caller
		// outside the runtime so independent allocation sites stay distinct.
		for _, frame := range stack {
			if !strings.HasPrefix(frame.Function, "runtime.") && !strings.HasPrefix(frame.Function, "internal/runtime/") {
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
		node := &snap.Sites
		for i := len(stack) - 1; i >= 0; i-- {
			frame := stack[i]
			file := fmt.Sprintf("%s:%d", frame.File, frame.Line)
			var next *allocFrame
			for _, child := range node.Children {
				if child.Name == frame.Function && child.File == file {
					next = child
					break
				}
			}
			if next == nil {
				next = &allocFrame{Name: frame.Function, File: file, Children: []*allocFrame{}}
				node.Children = append(node.Children, next)
			}
			node = next
		}
		node.Self += size
	}
	for _, entry := range groups {
		snap.Entries = append(snap.Entries, *entry)
	}
	sort.Slice(snap.Entries, func(i, j int) bool { return snap.Entries[i].Retained > snap.Entries[j].Retained })
	return snap
}
