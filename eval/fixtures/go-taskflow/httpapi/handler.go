// Package httpapi exposes the service over HTTP/JSON.
package httpapi

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"time"

	"example.com/taskflow/service"
	"example.com/taskflow/store"
)

// Handler adapts a service.Service to net/http. The service is embedded so
// route methods call use-cases directly.
type Handler struct {
	*service.Service
}

// NewHandler wraps the service for HTTP serving.
func NewHandler(svc *service.Service) *Handler {
	return &Handler{Service: svc}
}

// Routes registers the task endpoints on a fresh mux.
func (h *Handler) Routes() *http.ServeMux {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /tasks", h.handleCreate)
	mux.HandleFunc("GET /tasks", h.handleList)
	mux.HandleFunc("POST /tasks/{id}/complete", h.handleComplete)
	return mux
}

type createRequest struct {
	Title string    `json:"title"`
	Due   time.Time `json:"due"`
}

func (h *Handler) handleCreate(w http.ResponseWriter, r *http.Request) {
	var req createRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	task, err := h.CreateTask(req.Title, req.Due)
	if err != nil {
		writeError(w, http.StatusUnprocessableEntity, err)
		return
	}
	writeJSON(w, http.StatusCreated, task)
}

func (h *Handler) handleList(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, h.ListTasks())
}

func (h *Handler) handleComplete(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	if err := h.CompleteTask(id); err != nil {
		code := http.StatusInternalServerError
		if errors.Is(err, store.ErrNotFound) {
			code = http.StatusNotFound
		}
		writeError(w, code, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, err error) {
	writeJSON(w, code, map[string]string{"error": err.Error()})
}
