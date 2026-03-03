---
fixture: desktop-app-hatched
status: experimental
---

# Schedule Thread Grouping

## Goal

Verify that scheduled threads sharing the same schedule are grouped into a collapsible section in the sidebar, reducing clutter when multiple threads are created by the same recurring schedule.

## Prerequisites

This test creates a recurring schedule that fires every minute, waits for it to produce at least two threads, then verifies the grouping UI. The assistant must be fully hatched and ready to accept instructions.

## Steps

1. Launch the App
2. Open a chat thread and send the message: "Create a schedule called 'Test Grouping' that runs every minute and says 'ping'"
3. Wait for the assistant to confirm the schedule was created
4. Wait approximately 2-3 minutes for the schedule to fire at least twice, producing at least two scheduled threads
5. Look at the sidebar for a "Scheduled" section header below the regular threads
6. Verify that the two (or more) threads from the "Test Grouping" schedule are grouped under a single collapsible disclosure group with a clock icon, the label "Schedule" (derived from the title prefix "Schedule: Test Grouping"), and a count badge showing the number of threads
7. Click the disclosure group to expand it and verify the individual scheduled threads are listed inside
8. Click the disclosure group again to collapse it and verify the individual threads are hidden
9. Verify that the regular chat thread (where you sent the schedule creation message) still appears above the Scheduled section and is not affected by the grouping
10. Clean up by sending: "Delete the schedule called 'Test Grouping'"

## Expected

- The assistant should confirm the schedule was created
- After the schedule fires at least twice, a "Scheduled" section header should appear in the sidebar
- Threads from the same schedule should be grouped into a single collapsible row showing a clock icon, the schedule name, and a thread count badge
- Expanding the group should reveal the individual scheduled threads
- Collapsing the group should hide the individual threads
- Regular threads should remain unaffected above the Scheduled section
- The schedule should be successfully cleaned up at the end
