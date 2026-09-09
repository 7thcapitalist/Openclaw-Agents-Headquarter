# Overnight delivery

The overnight plan launches each queued request once. Recovery within that
objective uses the task engine's bounded repair and verification path. If the
objective worker stops before delivery, the queue records a failure, surfaces
it in Founder Inbox, and moves on to the next request. It must never submit
the same failed prompt repeatedly as new objectives.

Stop means finish the current objective and leave later requests queued. A plan
with failed work ends as `needs-attention`, not `complete`. Worker startup errors
also produce a failed item, even if a later process-close event arrives.

This change preserves the existing human merge gate. It does not guarantee that
all requests can finish overnight, nor that consuming all available credits is
useful work. Dashboard restart recovery and durable objective ownership need
further verification before an overnight reliability guarantee can be made.

Verification: queue tests simulate three requests with an initial failure,
worker-start failure, and stop during an active objective. The first failure
does not duplicate work or prevent later requests from completing.
