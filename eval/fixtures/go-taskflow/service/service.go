// Package service is the application layer between transport and storage.
package service

import (
	"fmt"
	"strings"
	"time"

	"example.com/taskflow/clock"
	"example.com/taskflow/store"
)

// Service wires task use-cases to a store.Store behind validation rules.
type Service struct {
	store store.Store
	clock clock.Clock
}

// New builds a Service on the given store and clock.
func New(s store.Store, c clock.Clock) *Service {
	return &Service{store: s, clock: c}
}

// CreateTask validates the title and stores a new open task.
func (s *Service) CreateTask(title string, due time.Time) (store.Task, error) {
	title = strings.TrimSpace(title)
	if title == "" {
		return store.Task{}, fmt.Errorf("title must not be empty")
	}
	t := store.Task{
		Title:     title,
		Due:       due,
		Status:    store.StatusOpen,
		CreatedAt: s.clock.Now(),
	}
	id, err := s.store.Add(t)
	if err != nil {
		return store.Task{}, fmt.Errorf("adding task: %w", err)
	}
	t.ID = id
	return t, nil
}

// CompleteTask marks a task done, passing store.ErrNotFound through.
func (s *Service) CompleteTask(id int64) error {
	return s.store.Complete(id)
}

// ListTasks returns every task in the store.
func (s *Service) ListTasks() []store.Task {
	return s.store.List()
}

// OverdueTasks filters the store's tasks down to overdue ones.
func (s *Service) OverdueTasks() []store.Task {
	now := s.clock.Now()
	var out []store.Task
	for _, t := range s.store.List() {
		if t.Overdue(now) {
			out = append(out, t)
		}
	}
	return out
}
