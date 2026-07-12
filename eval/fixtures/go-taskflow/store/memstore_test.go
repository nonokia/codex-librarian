package store

import (
	"errors"
	"testing"
	"time"
)

func TestMemStoreAdd(t *testing.T) {
	s := NewMemStore()
	id, err := s.Add(Task{Title: "write spec", Status: StatusOpen})
	if err != nil || id != 1 {
		t.Fatalf("Add = %d, %v", id, err)
	}
	t.Run("ids are sequential", func(t *testing.T) {
		id2, _ := s.Add(Task{Title: "review spec", Status: StatusOpen})
		if id2 != 2 {
			t.Fatalf("second id = %d", id2)
		}
	})
	t.Run("get returns the stored task", func(t *testing.T) {
		got, err := s.Get(id)
		if err != nil || got.Title != "write spec" {
			t.Fatalf("Get = %+v, %v", got, err)
		}
	})
}

func TestMemStoreComplete(t *testing.T) {
	s := NewMemStore()
	id, _ := s.Add(Task{Title: "ship it", Status: StatusOpen})
	if err := s.Complete(id); err != nil {
		t.Fatal(err)
	}
	got, _ := s.Get(id)
	if got.Status != StatusDone {
		t.Fatalf("status = %s", got.Status)
	}
	t.Run("missing id is ErrNotFound", func(t *testing.T) {
		if err := s.Complete(999); !errors.Is(err, ErrNotFound) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestTaskOverdue(t *testing.T) {
	now := time.Now()
	past := Task{Status: StatusOpen, Due: now.Add(-time.Hour)}
	if !past.Overdue(now) {
		t.Fatal("past open task should be overdue")
	}
	done := Task{Status: StatusDone, Due: now.Add(-time.Hour)}
	if done.Overdue(now) {
		t.Fatal("done task is never overdue")
	}
}
