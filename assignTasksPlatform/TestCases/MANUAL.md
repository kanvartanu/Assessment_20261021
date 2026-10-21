# Manual UI checks

The automated suite checks every case through the API. These checks need a browser. Run them against the app at http://localhost:3000 with `sim.speed_multiplier` at 1.

| # | Case | Steps | Pass when |
| --- | --- | --- | --- |
| M-U1 | Engine pick on the dashboard (U1) | Create a python task and wait for the offer | Within 1 s the row shows Offered, the contributor's name and a countdown from 120 s |
| M-U7 | Banner during a restart (U7, D12) | Accept an offer, then stop the server | The contributor's assignment page and the operator's task panel both show **Server unreachable. Timers are paused and will resume when the connection returns.** After a restart, the work clock carries on from where it stopped |
| M-E12 | Reroute now hidden (E12, D40) | Open an offered task and an in-progress task | No **Reroute now** button on either |
| M-I24 | Dashboard after restart (I24) | Keep a task selected and stop the server for 10 s, then start it | The banner appears within one poll and goes on the first successful poll. The selected task and the view are kept |
| M-OVD | Overdue badge | High-priority task whose engine never answers | After 25 s the row shows **Overdue · no answer for 25 s**, and the count keeps rising |
| M-RMV | Remove confirmation | Click Remove contributor on an in-progress task | The dialog reads **Priya Shah is working on this. Remove them and reroute?** (with the contributor's name) |
| M-409 | Conflict message in the UI | Two tabs on one offer: accept in one, then remove in the other | The losing tab shows the 409 message from the Errors table and refreshes |
| M-TL | Timeline lines | Open any task's history | One line per event in the form `HH:MM:SS  ACTOR  <display line>`, local time, display text as in the Event types table |
| M-I22 | Bad seed on Reset (I22) | Put keyword "healthcare" in `data/contributors.json`, then click Reset | The UI shows the seed error with "Nothing was reset" |
| M-I19 | Clean shutdown on Windows (I19) | Ctrl+C, wait 30 s, start | `server.restarted` shows `downtimeSeconds` ≈ 30. The automated I19 is skipped on Windows |
| M-XSS | Script in text fields (V2) | Create a task whose title, description and disclaimers are `<img src=x onerror=alert(1)>` | Dashboard, task panel, timeline and contributor offer show the text literally; no alert runs |
