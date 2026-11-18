package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestAdminUIStaticFiles(t *testing.T) {
	tests := []struct {
		urlPath      string
		expectedCode int
		expectedType string
		contains     string
	}{
		{"/admin/", http.StatusOK, "text/html; charset=utf-8", "id=\"app\""},
		{"/admin/css/style.css", http.StatusOK, "text/css; charset=utf-8", "[data-theme=\"dark\"]"},
		{"/admin/js/icons.js", http.StatusOK, "application/javascript; charset=utf-8", "renderHugeIcon"},
		{"/admin/js/app.js", http.StatusOK, "application/javascript; charset=utf-8", "loadLocale"},
		{"/admin/locales/zh.json", http.StatusOK, "application/json; charset=utf-8", "概览"},
		{"/admin/locales/en.json", http.StatusOK, "application/json; charset=utf-8", "Overview"},
		{"/admin/locales/es.json", http.StatusOK, "application/json; charset=utf-8", "Panel"},
	}

	for _, tc := range tests {
		req := httptest.NewRequest("GET", tc.urlPath, nil)
		w := httptest.NewRecorder()
		handleAdminUI(w, req)

		if w.Code != tc.expectedCode {
			t.Errorf("path %s: expected status %d, got %d", tc.urlPath, tc.expectedCode, w.Code)
		}
		ct := w.Header().Get("Content-Type")
		if ct != tc.expectedType {
			t.Errorf("path %s: expected content-type %s, got %s", tc.urlPath, tc.expectedType, ct)
		}
		body := w.Body.String()
		if !strings.Contains(body, tc.contains) {
			t.Errorf("path %s: body does not contain expected substring %q", tc.urlPath, tc.contains)
		}

		if strings.HasSuffix(tc.urlPath, ".json") {
			var parsed map[string]string
			if err := json.Unmarshal(w.Body.Bytes(), &parsed); err != nil {
				t.Errorf("path %s: invalid JSON: %v", tc.urlPath, err)
			}
			if len(parsed) < 100 {
				t.Errorf("path %s: expected at least 100 entries, got %d", tc.urlPath, len(parsed))
			}
		}
	}
}
