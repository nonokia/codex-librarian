package store

import (
	"sort"
	"sync"
)

// MemStore is the in-memory Store implementation used by the CLI and tests.
type MemStore struct {
	mu     sync.Mutex
	nextID int64
	tasks  map[int64]Task
}

// NewMemStore returns an empty in-memory store.
func NewMemStore() *MemStore {
	return &MemStore{nextID: 1, tasks: map[int64]Task{}}
}

// Add stores the task and returns its assigned id.
func (m *MemStore) Add(t Task) (int64, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t.ID = m.nextID
	m.nextID++
	m.tasks[t.ID] = t
	return t.ID, nil
}

// Get returns the task with the given id, or ErrNotFound.
func (m *MemStore) Get(id int64) (Task, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.tasks[id]
	if !ok {
		return Task{}, ErrNotFound
	}
	return t, nil
}

// List returns all tasks ordered by id.
func (m *MemStore) List() []Task {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]Task, 0, len(m.tasks))
	for _, t := range m.tasks {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
	return out
}

// Complete marks the task done; missing ids return ErrNotFound.
func (m *MemStore) Complete(id int64) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	t, ok := m.tasks[id]
	if !ok {
		return ErrNotFound
	}
	t.Status = StatusDone
	m.tasks[id] = t
	return nil
}
