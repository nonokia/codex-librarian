package httpapi

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"example.com/taskflow/clock"
	"example.com/taskflow/service"
	"example.com/taskflow/store"
)

func testHandler() *Handler {
	svc := service.New(store.NewMemStore(), clock.Fixed{At: time.Unix(0, 0)})
	return NewHandler(svc)
}

func TestHandleCreate(t *testing.T) {
	h := testHandler()
	t.Run("valid body creates a task", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/tasks", strings.NewReader(`{"title":"demo"}`))
		rec := httptest.NewRecorder()
		h.Routes().ServeHTTP(rec, req)
		if rec.Code != http.StatusCreated {
			t.Fatalf("status = %d, body = %s", rec.Code, rec.Body)
		}
	})
	t.Run("blank title is rejected", func(t *testing.T) {
		req := httptest.NewRequest("POST", "/tasks", strings.NewReader(`{"title":" "}`))
		rec := httptest.NewRecorder()
		h.Routes().ServeHTTP(rec, req)
		if rec.Code != http.StatusUnprocessableEntity {
			t.Fatalf("status = %d", rec.Code)
		}
	})
}

func TestHandleComplete(t *testing.T) {
	h := testHandler()
	req := httptest.NewRequest("POST", "/tasks/999/complete", nil)
	rec := httptest.NewRecorder()
	h.Routes().ServeHTTP(rec, req)
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d", rec.Code)
	}
}
