# Quick Reference - Voice Agent Enhancements

## 🎨 Visual Updates (SLDS Aligned)

### Icon Changes
| Old Style | New Style | Icon Name |
|-----------|-----------|-----------|
| Custom "⚙️" | 🎛️ SLDS | `utility:settings` |
| Custom mic icon | 🎤 SLDS | `utility:muted` |
| Custom send icon | ➤ SLDS | `utility:send` |
| Custom emoji 📎 | 🖼️ SLDS | `utility:image` |
| N/A (New) | 📷 SLDS | `utility:camera` |

### Button Styling
- **Shape**: Square with rounded corners (4px radius)
- **Size**: 40x40 pixels (standardized)
- **Hover**: Darker background + shadow
- **Active**: Scale transform + inset shadow
- **Focus**: Purple outline (accessibility)

---

## 🎙️ Voice Commands

### Available Commands in Voice Mode
```
Command              Action                  Response
─────────────────────────────────────────────────────────
"camera on"          Open camera            "📷 Camera mode activated"
"camera"             Open camera            "📷 Camera mode activated"
"take photo"         Open camera            "📷 Camera mode activated"
"capture"            Open camera            "📷 Camera mode activated"
"stop soma"          Exit to chat           Returns to chat mode
```

---

## 📷 Camera Features

### Chat Mode (Image Upload)
```
User Action          Flow
──────────────────────────────────────────────
Click Gallery Icon → File picker opens → Select image → Image appears in chat
Click Camera Icon  → Mobile camera opens → Capture photo → Photo appears in chat
```

### Voice Mode (Camera + Description)
```
User says "camera on"
       ↓
Camera opens (back camera on mobile)
       ↓
User captures photo
       ↓
Photo appears in chat
       ↓
System: "👂 Tell me about the photo"
       ↓
User describes photo (voice recognition active)
       ↓
Photo + description sent to Apex
       ↓
Agent responds with analysis
```

### Key Features
- ✅ Back camera on mobile (automatic)
- ✅ Automatic image compression (max 800px, quality 80%)
- ✅ Validates JPG/PNG only
- ✅ Voice continues while in camera mode
- ✅ Image + transcript sent together to Apex

---

## 🔄 Mode Transitions

### Chat Mode
- **Active when**: User is typing text
- **Visible buttons**: Gallery, Camera, Mic, Send
- **Behavior**: Normal text chat with image upload option

### Voice Mode  
- **Active when**: User clicks Mic or says "camera on"
- **Visible buttons**: Mic (toggle), Send (hidden), Close
- **Behavior**: Voice recognition active, amplitude bars animate

### Camera Mode (within Voice)
- **Activated by**: Voice command "camera on"
- **Duration**: Until photo is captured + description given
- **Special behavior**: Photo captured, then voice description appended

---

## 💬 User Interactions

### Text Chat Flow
```
1. Type message
2. Click Send (button or press Enter)
3. Message appears → Agent responds
4. Can upload image alongside
```

### Voice Chat Flow
```
1. Click Mic button
2. Voice recognition starts (amplitude bars animate)
3. Speak naturally
4. After 2.5 seconds of silence → Transcript sent
5. Agent responds with audio playback
```

### Photo + Voice Flow
```
1. In voice mode, say "camera on"
2. Take photo
3. Speak description (e.g., "This shows a broken screen")
4. After silence → Photo + description sent together
5. Agent responds with analysis
```

---

## 🛠️ Technical Details

### New Files
- `CHATBOX_ENHANCEMENTS.md` - Complete documentation (this file refers to it)

### Modified Files
- `voiceAgentIosFSL.html` - UI updates with SLDS icons, camera button
- `voiceAgentIosFSL.css` - Button styling, animations, responsive design
- `voiceAgentIosFSL.js` - Camera logic, voice commands, state management
- `AgentforceController.cls` - Accept userMessage parameter

### New Methods in JavaScript
```javascript
activateCameraMode()                    // Trigger camera from voice
handleCameraCaptureInVoiceMode()        // Process captured photo
sendImageWithVoiceDescription(text)     // Send photo + transcript to Apex
```

### New Voice Command Handler
```javascript
voiceCommands = {
    'stop soma': 'switchToChat',
    'camera on': 'activateCamera',      // ← NEW
    'camera': 'activateCamera',         // ← NEW
    'take photo': 'activateCamera',     // ← NEW
    'capture': 'activateCamera'         // ← NEW
}
```

---

## 🧪 Quick Test Checklist

- [ ] Icons display correctly (purple, SLDS style)
- [ ] Chat mode shows Gallery + Camera buttons
- [ ] Mic button starts voice mode
- [ ] Gallery button opens file picker
- [ ] Camera button opens device camera
- [ ] Voice command "camera on" works
- [ ] Photo is captured and displayed
- [ ] Voice continues after photo capture
- [ ] Photo + transcript sent to Apex together
- [ ] Agent responds with image analysis
- [ ] "Stop soma" exits voice mode cleanly
- [ ] No residual state between mode switches
- [ ] Buttons fade smoothly when switching modes
- [ ] Language selection works in voice mode

---

## 🚀 Performance Tips

- **Faster startup**: First voice command primes audio context
- **Smaller images**: Auto-compression saves bandwidth
- **Smooth animations**: CSS transitions use GPU where possible
- **Memory efficient**: Media streams cleaned up properly

---

## 📱 Device Compatibility

| Device | Gallery | Camera | Voice | Notes |
|--------|---------|--------|-------|-------|
| iPhone (Safari) | ✅ | ✅ Back | ✅ | Full support |
| Android (Chrome) | ✅ | ✅ Back | ✅ | Full support |
| Desktop (Chrome) | ✅ | 📁 File picker | ✅ | No webcam trigger |
| Desktop (Safari) | ✅ | 📁 File picker | ✅ | No webcam trigger |
| Tablet | ✅ | ✅ Back | ✅ | Same as phone |

---

## ❓ Common Questions

**Q: Why does camera only work on mobile?**
A: Mobile devices have physical cameras. Desktop uses file picker instead.

**Q: Can I take multiple photos?**
A: Currently single photo per voice session. Say "camera on" again for another.

**Q: What happens if I close the camera without capturing?**
A: Camera mode cancels and voice continues normally.

**Q: Can I use camera in chat mode?**
A: Yes! Click Camera button in chat mode - works like Gallery but opens camera instead.

**Q: Do voice descriptions need to be long?**
A: No - even "this is broken" works. The image analysis does most of the work.

**Q: What if agent doesn't recognize the image?**
A: Agent will still respond based on voice description. Image analysis helps provide context.

**Q: Is there a limit on file size?**
A: Images auto-compress to ~200KB. Original size doesn't matter.

**Q: Can I switch languages mid-conversation?**
A: Yes! Click Settings → Select language. New messages use selected language.

---

## 📞 Support

For issues:
1. Check browser console (F12 → Console tab)
2. Look for red error messages
3. Verify camera/microphone permissions in device settings
4. Try clearing browser cache
5. Refer to full documentation in `CHATBOX_ENHANCEMENTS.md`
