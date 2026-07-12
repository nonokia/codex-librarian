package service

import (
	"testing"
	"time"

	"example.com/taskflow/clock"
	"example.com/taskflow/store"
)

func fixedService() (*Service, *store.MemStore, time.Time) {
	at := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	ms := store.NewMemStore()
	return New(ms, clock.Fixed{At: at}), ms, at
}

func TestCreateTask(t *testing.T) {
	svc, _, at := fixedService()
	t.Run("stamps CreatedAt from the clock", func(t *testing.T) {
		task, err := svc.CreateTask("write handler", time.Time{})
		if err != nil {
			t.Fatal(err)
		}
		if !task.CreatedAt.Equal(at) {
			t.Fatalf("CreatedAt = %v, want %v", task.CreatedAt, at)
		}
	})
	t.Run("rejects blank titles", func(t *testing.T) {
		if _, err := svc.CreateTask("   ", time.Time{}); err == nil {
			t.Fatal("expected validation error")
		}
	})
}

func TestOverdueTasks(t *testing.T) {
	svc, ms, at := fixedService()
	ms.Add(store.Task{Title: "late", Status: store.StatusOpen, Due: at.Add(-time.Hour)})
	ms.Add(store.Task{Title: "future", Status: store.StatusOpen, Due: at.Add(time.Hour)})
	got := svc.OverdueTasks()
	if len(got) != 1 || got[0].Title != "late" {
		t.Fatalf("OverdueTasks = %+v", got)
	}
}
