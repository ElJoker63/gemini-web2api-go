package app

import (
	"bytes"
	"context"
	"io"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestToolSchemaIsCompact(t *testing.T) {
	sample := map[string]interface{}{
		"name":        "execute_command",
		"description": "Runs a command on the server",
		"parameters": map[string]interface{}{
			"type": "object",
			"properties": map[string]interface{}{
				"cmd": map[string]interface{}{
					"type":        "string",
					"description": "The command string",
				},
			},
			"required": []string{"cmd"},
		},
	}

	got := compactJSON(sample)
	if strings.Contains(got, "\n") || strings.Contains(got, "  ") {
		t.Errorf("compactJSON output is not compact: %s", got)
	}
	if !strings.Contains(got, `"name":"execute_command"`) {
		t.Errorf("expected compact JSON without spaces, got: %s", got)
	}
}

func TestContextFileKeepsToolProtocolInline(t *testing.T) {
	pc := promptCtx{
		Head:   "[TOOL DEFINITIONS: fetch_weather, execute_command]",
		Tail:   "[TOOL CALL INSTRUCTION: format as ```tool_call]",
		Latest: "What is the weather?",
	}
	// large body history that exceeds budget
	body := strings.Repeat("User: hello\nModel: hi\n", 50)
	fullPrompt := joinPromptParts(pc.Head, body, pc.Tail)

	budget := 2000
	history, inline := planContextFile(fullPrompt, pc, budget)

	if history == "" {
		t.Fatalf("expected dialogue history to be offloaded to history file")
	}
	if !strings.Contains(inline, pc.Head) {
		t.Errorf("expected inline prompt to retain tool definitions (pc.Head)")
	}
	if !strings.Contains(inline, pc.Tail) {
		t.Errorf("expected inline prompt to retain tool instruction (pc.Tail)")
	}
	if strings.Contains(inline, "User: hello") {
		t.Errorf("expected dialogue history to be removed from inline prompt")
	}
}

func TestToolCallComplete(t *testing.T) {
	tools := []map[string]interface{}{
		{
			"type": "function",
			"function": map[string]interface{}{
				"name": "get_weather",
			},
		},
	}
	checker := toolCallComplete(tools)

	incompleteText := "I will check the weather for you:\n```tool_call\n{\"name\": \"get_weather\", \"arguments\": {\"location\": \"Madrid\"}"
	if checker(incompleteText) {
		t.Errorf("expected incomplete fence to return false")
	}

	completeText := "I will check the weather for you:\n```tool_call\n{\"name\": \"get_weather\", \"arguments\": {\"location\": \"Madrid\"}}\n```"
	if !checker(completeText) {
		t.Errorf("expected closed fence with matching tool name to return true")
	}

	wrongToolText := "```tool_call\n{\"name\": \"unknown_func\"}\n```"
	if checker(wrongToolText) {
		t.Errorf("expected fence with unknown tool to return false")
	}
}

func TestStopReaderEndsReadEarly(t *testing.T) {
	originalData := "first chunk of data\nsecond chunk of data\nthird chunk of data"
	rc := io.NopCloser(bytes.NewBufferString(originalData))
	var stop atomic.Bool
	sr := stopReader{
		ReadCloser: rc,
		stop:       &stop,
	}

	buf := make([]byte, 10)
	n, err := sr.Read(buf)
	if err != nil || n != 10 {
		t.Fatalf("expected 10 bytes read, got %d, err: %v", n, err)
	}

	// Trigger early stop
	stop.Store(true)

	n2, err2 := sr.Read(buf)
	if err2 != io.EOF || n2 != 0 {
		t.Fatalf("expected EOF immediately after stop, got %d bytes, err: %v", n2, err2)
	}
}

func TestXSRFCacheSurvivesSIDCCRefresh(t *testing.T) {
	cookieA := "SAPISID=abc12345; __Secure-1PSID=xyz98765; __Secure-1PSIDCC=token_v1"
	cookieB := "SAPISID=abc12345; __Secure-1PSID=xyz98765; __Secure-1PSIDCC=token_v2_rotated"

	keyA := cookieIdentity(cookieA)
	keyB := cookieIdentity(cookieB)

	if keyA != keyB {
		t.Errorf("expected identical identity despite SIDCC change, got %q vs %q", keyA, keyB)
	}
}

func TestSleepCtxCancels(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately

	start := time.Now()
	err := sleepCtx(ctx, 500*time.Millisecond)
	elapsed := time.Since(start)

	if err == nil {
		t.Fatalf("expected error from cancelled context")
	}
	if elapsed > 100*time.Millisecond {
		t.Fatalf("sleepCtx did not return immediately on cancelled context: took %v", elapsed)
	}
}
