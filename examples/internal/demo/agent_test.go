package demo

import (
	"encoding/json"
	"math"
	"net"
	"reflect"
	"runtime"
	"strings"
	"testing"
	"time"
)

func TestAgentProtocol(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.Dial("tcp", listener.Addr().String())
	if err != nil {
		t.Fatal(err)
	}
	server, err := listener.Accept()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	server.SetDeadline(time.Now().Add(10 * time.Second))
	closeAgent := serveAgent(client, "test-token")
	defer closeAgent()
	decoder := json.NewDecoder(server)
	heapSeen, gcSeen := false, false
	read := func() map[string]any {
		t.Helper()
		var msg map[string]any
		if err := decoder.Decode(&msg); err != nil {
			t.Fatal(err)
		}
		switch msg["type"] {
		case "heap":
			heapSeen = true
			if msg["heapUsed"].(float64) <= 0 || msg["heapTotal"].(float64) < msg["heapUsed"].(float64) {
				t.Fatalf("bad heap statistics: %v", msg)
			}
		case "gc":
			gcSeen = true
			if msg["kind"] != "major" || msg["pauseMs"].(float64) < 0 || msg["t"].(float64) <= 0 {
				t.Fatalf("bad GC event: %v", msg)
			}
		}
		return msg
	}
	hello := read()
	if hello["type"] != "hello" || hello["runtime"] != "go" || hello["token"] != "test-token" || hello["pid"].(float64) <= 0 {
		t.Fatalf("invalid handshake: %v", hello)
	}

	// Commands can interleave with streamed heap and GC messages.
	for i, cmd := range []string{"snapshot", "gc", "unsupported"} {
		reqID := uint64(i + 1)
		if err := json.NewEncoder(server).Encode(map[string]any{"cmd": cmd, "reqId": reqID}); err != nil {
			t.Fatal(err)
		}
		for {
			msg := read()
			if msg["type"] != "reply" {
				continue
			}
			if msg["reqId"] != float64(reqID) || msg["ok"] != (cmd != "unsupported") {
				t.Fatalf("bad %s reply: %v", cmd, msg)
			}
			if cmd == "snapshot" {
				data, _ := json.Marshal(msg["data"])
				var snapshot heapSnapshot
				if err := json.Unmarshal(data, &snapshot); err != nil {
					t.Fatal(err)
				}
				if snapshot.HeapUsed == 0 || snapshot.Sites.Name != "(root)" {
					t.Fatalf("empty snapshot: %s", data)
				}
			}
			if cmd == "unsupported" && msg["error"] == nil {
				t.Fatal("unsupported command must return an error")
			}
			break
		}
	}
	for !heapSeen || !gcSeen {
		read()
	}
	// App disconnect and explicit cleanup can race and are both idempotent.
	server.Close()
	closed := make(chan struct{})
	go func() {
		closeAgent()
		closeAgent()
		close(closed)
	}()
	select {
	case <-closed:
	case <-time.After(3 * time.Second):
		t.Fatal("agent did not stop after the app disconnected")
	}
}

func TestSummarizeSampledAllocations(t *testing.T) {
	var record runtime.MemProfileRecord
	// Model Go 1.27's leading allocator/runtime frame. It must not collapse
	// unrelated application allocation functions into a runtime group.
	record.Stack0[0] = reflect.ValueOf(runtime.GC).Pointer() + 1
	runtime.Callers(1, record.Stack0[1:])
	record.AllocObjects, record.FreeObjects = 10, 4
	record.AllocBytes, record.FreeBytes = 10240, 4096
	empty := record
	empty.FreeObjects, empty.FreeBytes = empty.AllocObjects, empty.AllocBytes
	result := summarize([]runtime.MemProfileRecord{record, record, empty}, 1)
	if len(result.Entries) != 1 {
		t.Fatalf("expected one grouped allocation function, got %v", result.Entries)
	}
	entry := result.Entries[0]
	if !strings.Contains(entry.Name, "TestSummarizeSampledAllocations") || entry.Count != 12 || entry.Retained != 12288 || entry.Shallow != 12288 {
		t.Fatalf("incorrect in-use totals: %+v", entry)
	}
	var total func(allocFrame) float64
	total = func(frame allocFrame) float64 {
		result := frame.Self
		for _, child := range frame.Children {
			result += total(*child)
		}
		return result
	}
	if total(result.Sites) != entry.Retained || len(result.Sites.Children) != 1 {
		t.Fatal("allocation tree must merge shared stacks and preserve in-use bytes")
	}
	scaled := summarize([]runtime.MemProfileRecord{record}, 512*1024)
	want := 6144 / (1 - math.Exp(-1024.0/(512*1024)))
	if math.Abs(scaled.Entries[0].Retained-want) > 0.001 {
		t.Fatalf("sampling correction: got %v, want %v", scaled.Entries[0].Retained, want)
	}
}
