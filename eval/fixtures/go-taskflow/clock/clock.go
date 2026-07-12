// Package clock abstracts time for deterministic tests.
package clock

import "time"

// Clock supplies the current time.
type Clock interface {
	Now() time.Time
}

// RealClock is the production Clock backed by time.Now.
type RealClock struct{}

// Now returns the wall-clock time.
func (RealClock) Now() time.Time { return time.Now() }

// Fixed is a Clock pinned to a single instant, for tests.
type Fixed struct {
	At time.Time
}

// Now returns the pinned instant.
func (f Fixed) Now() time.Time { return f.At }
