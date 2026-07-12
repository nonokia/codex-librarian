// Command taskflow serves the task API on :8080.
package main

import (
	"log"
	"net/http"

	"example.com/taskflow/clock"
	"example.com/taskflow/httpapi"
	"example.com/taskflow/service"
	"example.com/taskflow/store"
)

func main() {
	svc := service.New(store.NewMemStore(), clock.RealClock{})
	h := httpapi.NewHandler(svc)
	log.Println("taskflow listening on :8080")
	log.Fatal(http.ListenAndServe(":8080", h.Routes()))
}
