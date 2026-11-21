package app

import (
	"strings"
	"testing"
)

func TestToolPromptAgentInstructions(t *testing.T) {
	tools := []map[string]interface{}{
		{
			"type": "function",
			"function": map[string]interface{}{
				"name":        "run_command",
				"description": "Execute shell command",
				"parameters": map[string]interface{}{
					"type": "object",
					"properties": map[string]interface{}{
						"command": map[string]interface{}{"type": "string"},
					},
				},
			},
		},
	}
	messages := []map[string]interface{}{
		{"role": "user", "content": "build the project and run tests"},
	}

	prompt, pc := messagesToPrompt(messages, tools, "auto")

	// 1. Validar que la cola contenga las instrucciones anti-alucinación de cuota
	if !strings.Contains(pc.Tail, "NEVER claim that tool quotas or calls are exhausted") {
		t.Errorf("promptCtx.Tail missing anti-quota instruction: %s", pc.Tail)
	}
	if !strings.Contains(pc.Tail, "Multi-step progress") {
		t.Errorf("promptCtx.Tail missing multi-step progress instruction: %s", pc.Tail)
	}
	if !strings.Contains(prompt, pc.Tail) {
		t.Errorf("prompt does not contain promptCtx.Tail")
	}

	// 2. Validar toolContinuationReminder
	rem := toolContinuationReminder(tools, "auto")
	if !strings.Contains(rem, "Never claim tool quota is exhausted") {
		t.Errorf("toolContinuationReminder missing quota reminder: %s", rem)
	}

	remForced := toolContinuationReminder(tools, map[string]interface{}{
		"type":     "function",
		"function": map[string]interface{}{"name": "run_command"},
	})
	if !strings.Contains(remForced, `MUST call the tool "run_command"`) {
		t.Errorf("toolContinuationReminder forced missing tool name: %s", remForced)
	}
}

func TestFormatToolResultMultiStep(t *testing.T) {
	// exit 0 without output
	rEmpty := formatToolResult("run_command", "Process exited with code 0\nOutput:\n")
	if !strings.Contains(rEmpty, "命令成功（exit 0）") || !strings.Contains(rEmpty, "若有后续步骤请继续执行") {
		t.Errorf("unexpected empty exit 0 format: %s", rEmpty)
	}

	// exit 0 with output
	rOut := formatToolResult("run_command", "Process exited with code 0\nOutput:\nall files listed")
	if !strings.Contains(rOut, "all files listed") {
		t.Errorf("unexpected output exit 0 format: %s", rOut)
	}

	// exit 1 failure
	rFail := formatToolResult("run_command", "Process exited with code 1\nOutput:\nerror 404")
	if !strings.Contains(rFail, "命令失败（exit 1）") {
		t.Errorf("unexpected failure format: %s", rFail)
	}
}
