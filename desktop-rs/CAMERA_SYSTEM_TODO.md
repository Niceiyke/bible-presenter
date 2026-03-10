# Wordlyte Camera System - Production Readiness TODO

This list covers the remaining manual and technical steps required to ship the Native GStreamer/NDI engine to end-users.

## 1. 📦 GStreamer Bundling (Zero-Setup Experience)
To ensure users don't need to install GStreamer manually, follow these steps before your next production build:

- [ ] **Download Runtime Binaries:**
    - **Windows:** Download "GStreamer 1.0 Runtime MSVC 64-bit" from [gstreamer.freedesktop.org](https://gstreamer.freedesktop.org/download/).
    - **Mac:** Download the GStreamer .pkg runtime.
- [ ] **Populate Local Bin Folder:** 
    - Create the directory: `src-tauri/bin/gstreamer/`
    - Copy the contents of the GStreamer installation into this folder.
    - **Crucial:** Ensure the folder contains `bin/` (DLLs) and `lib/gstreamer-1.0/` (Plugins).
- [ ] **Test Bundling:** Run `npm run tauri build` and install it on a clean machine (without GStreamer installed) to verify the `init_bundled_gstreamer` logic works.

## 2. 🔌 Professional NDI® Support
- [ ] **NDI GStreamer Plugin:** The standard GStreamer install doesn't always include `ndisrc`. You must ensure `gst-plugin-ndi` is in the `lib/gstreamer-1.0/` folder of your bundle.
- [ ] **Network Discovery:** Test with OBS (using NDI Output) or a PTZ camera on the same network to ensure the **Scan** button in the Camera Tab picks them up.

## 3. 🧪 Final Performance Validation
- [ ] **Binary Pipe Stress Test:** Open the Output Window and the Camera Tab at the same time. Verify that the `wordlyte-stream://` protocol handles high resolution without lagging the UI.
- [ ] **Lifecycle Verification:** Switch between Browser Engine and Native Engine multiple times. Ensure no "zombie" camera processes remain active in the background.
- [ ] **Windows Driver Check:** On Windows, verify that `autovideosrc` correctly detects both integrated webcams and external capture cards (Magewell/Blackmagic).

## 4. 🛠 Future Engine Enhancements
- [ ] **Multi-Source Layouts:** Expand the `MediaSource` struct to allow "Side-by-Side" or "Picture-in-Picture" native mixing.
- [ ] **Native Audio Routing:** Add an `autoaudiosink` branch to the GStreamer pipeline to allow camera/NDI audio to be routed to the system output.

---
*Last Updated: March 10, 2026 | Status: Infrastructure Complete, Ready for Bundling.*
