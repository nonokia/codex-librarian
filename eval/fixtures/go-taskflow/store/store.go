package store

import "errors"

// ErrNotFound is returned when a task id has no record.
var ErrNotFound = errors.New("task not found")

// Reader is the read-only half of the persistence seam.
type Reader interface {
	Get(id int64) (Task, error)
	List() []Task
}

// Store is the full persistence seam; Reader is embedded so read-only
// consumers can depend on the narrower interface.
type Store interface {
	Reader
	Add(t Task) (int64, error)
	Complete(id int64) error
}
