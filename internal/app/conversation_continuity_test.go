package app

import (
	"fmt"
	"testing"
)

func TestConvFindExplicitID(t *testing.T) {
	fakeState := &convState{
		cid:       "c_explicit_123",
		rid:       "r_123",
		rcid:      "rc_123",
		keyID:     1,
		isLogin:   true,
		accountID: 10,
	}

	convPut("id:session_xyz", fakeState)
	convPut("cid:"+fakeState.cid, fakeState)

	t.Cleanup(func() {
		convDelete("id:session_xyz")
		convDelete("cid:" + fakeState.cid)
	})

	// 1. Find by session ID
	st, matchedKey := convFind([]map[string]interface{}{
		{"role": "user", "content": "hello again"},
	}, 1, "session_xyz")

	if st == nil || matchedKey != "id:session_xyz" {
		t.Fatalf("expected to find state by explicit convID, got st=%v, matchedKey=%s", st, matchedKey)
	}

	// 2. Find by CID
	stCID, matchedKeyCID := convFind([]map[string]interface{}{
		{"role": "user", "content": "another turn"},
	}, 1, "c_explicit_123")

	if stCID == nil || matchedKeyCID != "cid:c_explicit_123" {
		t.Fatalf("expected to find state by CID, got st=%v, matchedKey=%s", stCID, matchedKeyCID)
	}
}

func TestConvFindAcrossSystemPromptVariations(t *testing.T) {
	keyID := int64(2)
	baseHistory := []map[string]interface{}{
		{"role": "system", "content": "You are assistant at 10:00:00"},
		{"role": "user", "content": "My name is Alice"},
		{"role": "assistant", "content": "Nice to meet you Alice"},
	}

	fakeState := &convState{
		cid:   "c_alice_001",
		rid:   "r_alice_001",
		keyID: keyID,
	}

	// Simulate saving child state as done by callGeminiConv
	childKey := convChildKey(baseHistory[:2], "Nice to meet you Alice", keyID)
	convPut(childKey, fakeState)

	chatStr := canonicalChatMessages(baseHistory)
	chatKey := hashStr(fmt.Sprintf("%d\x1fchat\x1f%s", keyID, chatStr))
	convPut(chatKey, fakeState)

	t.Cleanup(func() {
		convDelete(childKey)
		convDelete(chatKey)
	})

	// Client sends turn 2, but system prompt injected a new timestamp or new memory
	turn2History := []map[string]interface{}{
		{"role": "system", "content": "You are assistant at 10:00:05. User memory: Alice loves cats"},
		{"role": "user", "content": "My name is Alice"},
		{"role": "assistant", "content": "Nice to meet you Alice"},
		{"role": "user", "content": "What is my name?"},
	}

	// Parent key for full messages will miss because system prompt changed
	parentFullKey := convParentKey(turn2History, keyID)
	if convGet(parentFullKey) != nil {
		t.Fatal("expected full parentKey to miss due to dynamic system prompt")
	}

	// But convFind should match using canonicalChatMessages (chatKey)
	st, matchedKey := convFind(turn2History, keyID, "")
	if st == nil {
		t.Fatalf("expected convFind to hit chatKey despite system prompt mutation, got nil")
	}
	if matchedKey != chatKey {
		t.Fatalf("expected matchedKey == chatKey (%s), got %s", chatKey, matchedKey)
	}
	if st.cid != "c_alice_001" {
		t.Fatalf("expected cid c_alice_001, got %s", st.cid)
	}
}

func TestConvFindAcrossSlidingWindowTruncation(t *testing.T) {
	keyID := int64(3)
	// Full conversation that had 5 turns
	fullHistory := []map[string]interface{}{
		{"role": "user", "content": "Turn 1 user"},
		{"role": "assistant", "content": "Turn 1 assistant"},
		{"role": "user", "content": "Turn 2 user"},
		{"role": "assistant", "content": "Turn 2 assistant"},
	}

	fakeState := &convState{
		cid:   "c_window_999",
		rid:   "r_window_999",
		keyID: keyID,
	}

	turnKey := convLastTurnKey(fullHistory[:3], "Turn 2 assistant", keyID)
	convPut(turnKey, fakeState)

	t.Cleanup(func() {
		convDelete(turnKey)
	})

	// Client or proxy sliding window dropped Turn 1, so incoming messages are only Turn 2 + Turn 3
	incomingTruncated := []map[string]interface{}{
		{"role": "user", "content": "Turn 2 user"},
		{"role": "assistant", "content": "Turn 2 assistant"},
		{"role": "user", "content": "Turn 3 user"},
	}

	st, matchedKey := convFind(incomingTruncated, keyID, "")
	if st == nil {
		t.Fatalf("expected convFind to hit turnKey on truncated window, got nil")
	}
	if matchedKey != turnKey {
		t.Fatalf("expected matchedKey == turnKey (%s), got %s", turnKey, matchedKey)
	}
	if st.cid != "c_window_999" {
		t.Fatalf("expected cid c_window_999, got %s", st.cid)
	}
}
