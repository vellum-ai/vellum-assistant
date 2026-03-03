---
fixture: desktop-app-hatched
status: experimental
---

# Schedule Thread Grouping

## Goal

Verify that scheduled threads sharing the same schedule are grouped into a collapsible section in the sidebar, reducing clutter when multiple threads are created by the same recurring schedule.

## Steps

1. Launch the App
2. Open the sidebar and look for a "Scheduled" section header below the regular threads
3. If scheduled threads exist and share the same schedule, verify they are grouped under a single collapsible disclosure group with an icon, a label derived from the schedule name, and a count badge showing the number of threads in the group
4. Click the disclosure group to expand it and verify the individual threads are listed inside
5. Click the disclosure group again to collapse it and verify the threads are hidden
6. If a schedule has only one thread, verify it appears inline without a disclosure wrapper
7. Verify that regular (non-scheduled) threads still appear above the Scheduled section and are not affected by the grouping

## Expected

- A "Scheduled" section header should appear in the sidebar when scheduled threads exist
- Threads from the same schedule should be grouped into a single collapsible row showing a clock icon, the schedule name, and a thread count badge
- Expanding the group should reveal the individual scheduled threads
- Collapsing the group should hide the individual threads
- Single-thread schedules should render inline without a disclosure group wrapper
- Regular threads should remain unaffected above the Scheduled section
