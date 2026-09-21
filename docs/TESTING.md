# Testing

## Automated

```bash
npm test          # unit suite
npm run check     # Astro + TypeScript diagnostics
```

### What was verified in development

Development happened on Linux, with the app driven in **headless Chromium at a
393×852 iPhone viewport** (iOS user-agent, touch enabled) against a mocked
Supabase project serving real WAV audio and real PNG artwork.

Verified working end to end:

- Onboarding: validation, connection test, refusal of a service-role key
- A remembered connection restoring straight into the library
- Home, Library (all four tabs), Search, album, artist, playlist, Settings
- Artwork loading through batched signed URLs
- Tapping a track → audio actually decoding and playing
- Play, pause, next, previous, seek, shuffle, repeat
- **Audio continuing uninterrupted across a four-screen in-app navigation tour**
- A track finishing and auto-advancing to the next one
- Recovery from a dead/expired audio URL, resuming at the same position
- Queue sheet: listing, jumping, removing
- Track action sheet, playlist reorder/remove actions
- Theme switching and preference persistence across reloads

### What was NOT verified

Anything that requires real iOS hardware. Specifically:

- Lock-screen metadata and transport controls
- Playback continuing when the screen locks
- Behaviour when the PWA is backgrounded or the app is switched away from
- Whether iOS suspends audio after a long idle period
- Home Screen installation and the standalone launch experience
- Safe-area insets on a physical notched device

The Media Session API is wired up and feature-detected, but **no claim is made
that background playback works on iOS until you confirm it below.**

---

## Manual iPhone checklist

Run this on the real device, over HTTPS.

### Setup
- [ ] Site loads in Safari on iPhone
- [ ] Onboarding screen is readable, inputs don't trigger zoom on focus
- [ ] **Test** reports tables and bucket correctly
- [ ] Pasting a service-role key is refused with an explanation
- [ ] **Connect** works, then sign-in succeeds
- [ ] Close Safari entirely, reopen → lands straight in the library

### Install as a PWA
- [ ] Share → Add to Home Screen shows the Resonance icon
- [ ] Launching from the Home Screen opens full-screen with no Safari chrome
- [ ] Status bar is readable against the dark background
- [ ] Content clears the notch and the home indicator

### Layout
- [ ] Tab bar sits above the home indicator, not under it
- [ ] Every control is comfortably tappable one-handed
- [ ] Nothing scrolls horizontally
- [ ] Artwork is sharp on the Retina display
- [ ] Album/playlist headers look right on a small screen

### Playback
- [ ] Tapping a track starts audio within a second or two
- [ ] Mini player appears and shows the right track
- [ ] Mini player expands into Now Playing (tap and swipe up)
- [ ] Swipe down dismisses Now Playing
- [ ] Play/pause, next, previous all work
- [ ] Scrubbing is smooth and lands where you dropped it
- [ ] Shuffle and repeat behave as expected
- [ ] Queue sheet lists what's coming and jumping works
- [ ] Playback keeps going while moving between tabs
- [ ] A track ending advances to the next one
- [ ] Reaching the end of a queue stops cleanly (no error)

### iOS-specific — the important ones
- [ ] **Lock the screen mid-song — does audio keep playing?**
- [ ] **Do the lock screen / Control Center show the title, artist and artwork?**
- [ ] **Do the lock-screen play/pause/skip buttons work?**
- [ ] Does audio survive switching to another app and back?
- [ ] Does it survive ~5 minutes locked?
- [ ] Does a phone call interrupt and then resume correctly?
- [ ] Do the hardware volume buttons work (the in-app slider is hidden by design)?

Record whatever you find here — especially the lock-screen items, since those
are the ones that can't be verified without the device.

### Network conditions
- [ ] Turn on Airplane Mode mid-song → a clear error, not a blank screen
- [ ] Reconnect → playback can be resumed
- [ ] On slow cellular, artwork and metadata still load in a sensible order
- [ ] Leave a track playing for over an hour → signed URL refresh is invisible

### Error handling
- [ ] Wrong project URL → clear message
- [ ] Right URL, wrong key → clear message
- [ ] Tables missing → tells you to run the migrations
- [ ] Wrong bucket name → tells you the bucket is missing
- [ ] Signed out → prompted to sign in, not left with a blank library
- [ ] Empty library → helpful empty state, not a blank screen
- [ ] A track whose file is missing from Storage → clear error, app stays usable

### Settings
- [ ] Connection status and library counts are accurate
- [ ] Theme switching works and survives a reload
- [ ] Shuffle/repeat preferences survive a reload
- [ ] *Disconnect and clear saved settings* returns you to onboarding
- [ ] After clearing, reopening the app shows onboarding (nothing left behind)
