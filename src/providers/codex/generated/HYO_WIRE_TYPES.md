# Hyo Codex wire type normalization

App-server JSON numbers are parsed by JSON.parse as JavaScript numbers.
The Codex generator emits some bigint declarations for counts, limits, durations, and timestamps;
Hyo normalizes those declarations to number so exposed production types match runtime values.
These protocol values are expected to remain within JavaScript's safe integer range.
