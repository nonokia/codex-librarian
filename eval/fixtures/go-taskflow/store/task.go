// Package store holds the task domain model and its persistence seam.
package store

import "time"

// Status is the lifecycle state of a Task.
type Status string

const (
	StatusOpen Status = "open"
	StatusDone Status = "done"
)

// Task is the unit of work tracked by taskflow.
type Task struct {
	ID        int64
	Title     string
	Due       time.Time
	Status    Status
	CreatedAt time.Time
}

// Overdue reports whether the task is past due and still open.
func (t Task) Overdue(now time.Time) bool {
	return t.Status == StatusOpen && !t.Due.IsZero() && t.Due.Before(now)
}
