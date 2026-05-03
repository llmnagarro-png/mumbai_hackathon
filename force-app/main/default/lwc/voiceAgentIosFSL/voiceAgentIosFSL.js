import { LightningElement, api, track } from 'lwc';
import { NavigationMixin } from 'lightning/navigation';
import callAgentforce from '@salesforce/apex/AgentforceController.callAgentforce';
import analyzeImageOnly from '@salesforce/apex/AgentforceController.analyzeImageOnly';

const SILENCE_TIMEOUT_MS = 2500;

export default class VoiceAgentIosFSL extends NavigationMixin(LightningElement) {
    @api sessionId = null;
    @api userFirstName = '';
    @api selectedLanguage = 'en-US';
    @api deviceType = 'PHONE';
    @api greetingVoices = {};
    @api voiceGenderGetter = null;
    @api userId

    @track messages = [];
    @track isProcessing = false;
    @track mode = 'chat';
    @track showSettings = false;
    @track blobActive = false;
    @track isSpeaking = false;
    @track debugMessage = '';
    @track ttsSubtitle;
    @track ttsCurrentWordIndex = -1;
    @track ttsWords = [];
    @track imageUrl;
    @track pendingImageBase64 = null;
    @track pendingImagePreview = null;
    @track showAttachMenu = false;
    @track showVoiceAttachMenu = false;
    @track voiceMapCards = [];

    userInput = '';
    recognition = null;
    speechSynthesis = window.speechSynthesis;
    speechEndTimeout = null;
    speechBuffer = '';
    speechBufferTimeout = null;
    currentUtterance = null;
    speechKeepAliveInterval = null;
    _currentAudio = null;
    defaultRecognitionOnEnd = null;
    recognitionActive = false;
    lastAgentOutput = '';
    _analyser = null;
    _microphone = null;
    _amplitudeData = null;
    _amplitudeAnimFrame = null;
    _ttsAnimFrame = null;
    _stopTTSBlobAnimation = null;
    _lastLangGreetings;
    _interimSilenceTimer = null;
    _partialTranscript = '';
    useSpeechSynthesis = false;
    _userGestureContext = false;

    _iosAudioContext = null;
    _iosAudioBuffer = null;
    _iosAudioSource = null;
    _preloadedAudioUrls = new Map();
    _mediaStream = null;
    _voiceRecognitionRestartAttempts = 0;
    _maxRestartAttempts = 3;

    _wakeLock = null;
    _wakeLockVideo = null;
    _wakeLockActive = false;

    voiceCommands = {
        'stop soma': 'switchToChat',
        'camera on': 'activateCamera',
        'camera': 'activateCamera',
        'take photo': 'activateCamera',
        'capture': 'activateCamera'
    };

    _cameraMode = false;
    _capturedImageData = null;
    _cameraPhoneNumber = null;

    get isHomeMode() {
        return this.mode === 'home';
    }

    get isListeningMode() {
        return this.mode === 'listening';
    }

    get isChatMode() {
        return this.mode === 'chat';
    }

    get formattedMessages() {
        return this.messages.map(m => ({
            ...m,
            bubbleClass: m.from === 'user' ? 'user-msg' : 'agent-msg',
            time: this.formatTime(m.timestamp),
            textSegments: this.renderTextSegments(m.text)
        }));
    }

    get deviceClass() {
        return (this.deviceType === 'DESKTOP' ? 'desktop-view' : 'mobile-view') + ' chat-container';
    }

    get statusText() {
        if (this.isProcessing) {
            return 'Processing...';
        } else if (this.isSpeaking) {
            return 'Speaking...';
        } else if (this.isListeningMode && this._partialTranscript && !this.isProcessing && !this.isSpeaking) {
            return this._partialTranscript.trim();
        } else if (this.isListeningMode) {
            return 'Listening...';
        }
        return '';
    }

    get blobClass() {
        if (this.isProcessing) return 'processing';
        if (this.isSpeaking) return 'speaking';
        if (this.blobActive) return 'active';
        return '';
    }

    get recognitionLang() {
        return this.selectedLanguage;
    }

    get ttsSubtitleWords() {
        if (!this.ttsSubtitle) return [];
        return this.ttsWords.map((word, i) => ({
            word,
            class: 'tts-word' + (i === this.ttsCurrentWordIndex ? ' tts-word-active' : '')
        }));
    }

    get amplitudeBarsClass() {
        if (this.isSpeaking) return 'amplitude-bars speaking';
        if (this.isListeningMode && this.blobActive) return 'amplitude-bars listening';
        return 'amplitude-bars idle';
    }

    get languageOptions() {
        return [
            { label: 'English', value: 'en-US' },
            { label: 'German', value: 'de-DE' },
            { label: 'Japanese', value: 'ja-JP' },
            { label: 'Hindi', value: 'hi-IN' }
        ];
    }

    formatTime(timestamp) {
        const date = new Date(timestamp);
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    renderTextSegments(text) {
        if (!text) return [{ id: 'seg-0', spanClass: 'msg-text-plain', text: '', url: null }];
        const urlRegex = /https?:\/\/[^\s\])'"\n]+/g;
        const segments = [];
        let lastIndex = 0;
        let match;
        let idx = 0;
        while ((match = urlRegex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                segments.push({ id: `seg-${idx++}`, spanClass: 'msg-text-plain', text: text.slice(lastIndex, match.index), url: null });
            }
            const url = match[0].replace(/[.,;!?)\[\]]+$/, '');
            segments.push({ id: `seg-${idx++}`, spanClass: 'msg-inline-link', text: url, url });
            lastIndex = match.index + match[0].length;
        }
        if (lastIndex < text.length) {
            segments.push({ id: `seg-${idx++}`, spanClass: 'msg-text-plain', text: text.slice(lastIndex), url: null });
        }
        return segments.length > 0 ? segments : [{ id: 'seg-0', spanClass: 'msg-text-plain', text, url: null }];
    }

    connectedCallback() {
        console.log('[VoiceAgentIOS] Initializing iOS component');
        this.logAudioContextState();
        
        setTimeout(() => this.resetAmplitudeBars(), 100);
        
        this.initializeWakeLock();
        
        this.handleVisibilityChange = this.handleVisibilityChange.bind(this);
        document.addEventListener('visibilitychange', this.handleVisibilityChange);
    }

    logAudioContextState() {
        console.log('[VoiceAgentIOS] Audio Context State:', {
            iosAudioContext: this._iosAudioContext ? this._iosAudioContext.state : 'null',
            audioContext: this._audioContext ? this._audioContext.state : 'null',
            recognitionActive: this.recognitionActive,
            mode: this.mode,
            restartAttempts: this._voiceRecognitionRestartAttempts,
            wakeLockActive: this._wakeLockActive
        });
    }

    initializeWakeLock() {
        console.log('[VoiceAgentIOS] Initializing wake lock system');
        
        this.createSilentVideoElement();
        
        if ('wakeLock' in navigator) {
            console.log('[VoiceAgentIOS] Wake Lock API supported');
        } else {
            console.log('[VoiceAgentIOS] Wake Lock API not supported, using video fallback');
        }
    }

    createSilentVideoElement() {
        try {
            this._wakeLockVideo = document.createElement('video');
            this._wakeLockVideo.setAttribute('muted', 'true');
            this._wakeLockVideo.setAttribute('playsinline', 'true');
            this._wakeLockVideo.setAttribute('loop', 'true');
            this._wakeLockVideo.style.position = 'absolute';
            this._wakeLockVideo.style.opacity = '0';
            this._wakeLockVideo.style.pointerEvents = 'none';
            this._wakeLockVideo.style.width = '1px';
            this._wakeLockVideo.style.height = '1px';
            this._wakeLockVideo.style.zIndex = '-1000';
            
            const silentVideoDataURL = 'data:video/mp4;base64,AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMQAAAAAtbW9vdgAAAGxtdmhkAAAAANUbgM7VG4DOwAAD6AAAACoAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAABlpb2RzAAAAABCAgIAIAE/////+/wAABZl0cmFrAAAAXHRraGQAAAAB1RuAztUbgM4AAAABAAAAAAAAAFAAAAAAAAAAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAABAABAAAAABAAAAAAACIW1kaWEAAAAgbWRoZAAAAADVG4DO1RuAzgAAA+gAAACoVcQAAAAAAC5oZGxyAAAAAAAAAAB2aWRlAAAAAAAAAAAAAAAAVmlkZW9IYW5kbGVyAAAAASJtaW5mAAAAFHZtaGQAAAABAAAAAAAAAAAAAAAkZGluZgAAABxkcmVmAAAAAAAAAAEAAAAMdXJsIAAAAAEAAAAA4nN0YmwAAAB0c3RzZAAAAAAAAAABAAAAZGF2YzEAAAAAAAAAAQAAAAAAAAAAAAAAAAAAAAAABAAEAEgAAABIAAAAAAAAAAEYYXZjQwFkAAv/4QAYZ//hABhnf/77y/fxy13MAAADAAEAAAMAWA==';
            this._wakeLockVideo.src = silentVideoDataURL;
            
            this._wakeLockVideo.addEventListener('canplay', () => {
                console.log('[VoiceAgentIOS] Silent video ready for wake lock');
            });
            
            this._wakeLockVideo.addEventListener('error', (e) => {
                console.warn('[VoiceAgentIOS] Silent video error:', e);
            });
            
            console.log('[VoiceAgentIOS] Silent video element created');
        } catch (error) {
            console.error('[VoiceAgentIOS] Failed to create silent video element:', error);
        }
    }

    async enableScreenWakeLock() {
        if (this._wakeLockActive) {
            console.log('[VoiceAgentIOS] Wake lock already active');
            return;
        }

        console.log('[VoiceAgentIOS] Enabling screen wake lock for voice conversation');
        
        try {
            if ('wakeLock' in navigator && navigator.wakeLock) {
                this._wakeLock = await navigator.wakeLock.request('screen');
                this._wakeLock.addEventListener('release', () => {
                    console.log('[VoiceAgentIOS] Wake Lock API released');
                });
                console.log('[VoiceAgentIOS] Wake Lock API enabled successfully');
                this._wakeLockActive = true;
                return;
            }
        } catch (error) {
            console.warn('[VoiceAgentIOS] Wake Lock API failed:', error.message);
        }

        try {
            if (this._wakeLockVideo) {
                const container = this.template.querySelector('.voice-overlay') || document.body;
                if (container && !container.contains(this._wakeLockVideo)) {
                    container.appendChild(this._wakeLockVideo);
                }
                
                await this._wakeLockVideo.play();
                console.log('[VoiceAgentIOS] Silent video wake lock enabled');
                this._wakeLockActive = true;
            }
        } catch (error) {
            console.error('[VoiceAgentIOS] Failed to enable video wake lock:', error);
        }
    }

    async disableScreenWakeLock() {
        if (!this._wakeLockActive) {
            return;
        }

        console.log('[VoiceAgentIOS] Disabling screen wake lock');

        try {
            if (this._wakeLock) {
                await this._wakeLock.release();
                this._wakeLock = null;
                console.log('[VoiceAgentIOS] Wake Lock API disabled');
            }
        } catch (error) {
            console.warn('[VoiceAgentIOS] Error releasing Wake Lock API:', error);
        }

        try {
            if (this._wakeLockVideo) {
                this._wakeLockVideo.pause();
                this._wakeLockVideo.currentTime = 0;
                
                if (this._wakeLockVideo.parentNode) {
                    this._wakeLockVideo.parentNode.removeChild(this._wakeLockVideo);
                }
                console.log('[VoiceAgentIOS] Silent video wake lock disabled');
            }
        } catch (error) {
            console.warn('[VoiceAgentIOS] Error stopping silent video:', error);
        }

        this._wakeLockActive = false;
    }

    handleVisibilityChange() {
        if (!document.hidden && this.isListeningMode && !this._wakeLockActive) {
            console.log('[VoiceAgentIOS] Page visible again, re-acquiring wake lock');
            this.enableScreenWakeLock();
        }
    }

    disconnectedCallback() {
        document.removeEventListener('visibilitychange', this.handleVisibilityChange);
        
        this.stopVoiceInput();
        if (this._currentAudio) {
            this._currentAudio.pause();
            this._currentAudio = null;
        }
        if (this.currentUtterance) {
            this.currentUtterance = null;
        }
        if (this.speechKeepAliveInterval) {
            clearInterval(this.speechKeepAliveInterval);
            this.speechKeepAliveInterval = null;
        }

        if (this._mediaStream) {
            this._mediaStream.getTracks().forEach(track => track.stop());
            this._mediaStream = null;
        }

        this.disableScreenWakeLock();
        if (this._wakeLockVideo) {
            this._wakeLockVideo = null;
        }

        if (this._iosAudioSource) {
            try {
                this._iosAudioSource.stop();
            } catch (e) { }
            this._iosAudioSource = null;
        }
        if (this._iosAudioContext) {
            this._iosAudioContext.close();
            this._iosAudioContext = null;
        }
    }

    handleSend(e) {
        const inputEl = this.template.querySelector('.chat-input');
        const value = inputEl ? inputEl.value.trim() : (this.userInput || '').trim();

        if (!value && !this.pendingImageBase64) return;

        this.userInput = value;
        if (inputEl) inputEl.value = '';

        if (this.pendingImageBase64) {
            this.sendMessageWithPendingImage(value);
        } else {
            this.sendMessage();
        }
    }

    toggleAttachMenu() {
        this.showAttachMenu = !this.showAttachMenu;
    }

    closeAttachMenu() {
        this.showAttachMenu = false;
    }

    toggleVoiceAttachMenu() {
        this.showVoiceAttachMenu = !this.showVoiceAttachMenu;
    }

    closeVoiceAttachMenu() {
        this.showVoiceAttachMenu = false;
    }

    handleVoiceGallerySelect(event) {
        this.showVoiceAttachMenu = false;
        this.handleOpenCamera(event);
    }

    handleVoiceCameraSelect(event) {
        this.showVoiceAttachMenu = false;
        this.handleOpenCamera(event);
    }

    handleGallerySelect(event) {
        this.showAttachMenu = false;
        this.handleImageUpload(event);
    }

    handleCameraSelect(event) {
        this.showAttachMenu = false;
        this.handleOpenCamera(event);
    }

    triggerFileInput() {
        const fileInput = this.template.querySelector('.file-input-hidden');
        if (fileInput) {
            fileInput.click();
        }
    }

    triggerCameraInput() {
        const cameraInput = this.template.querySelector('.camera-input-hidden');
        console.log('camera icon clicked...',cameraInput);
        if (cameraInput) {
            cameraInput.click();
        }
    }

    handleOpenCamera(event){
        const file = event.target.files[0]; 
        console.log('Camera file Input : ',file);
        
        if (this._cameraMode || this.mode === 'listening') {
            this.handleCameraCaptureInVoiceMode(event);
        } else {
            this.handleImageUpload(event);
        }
    }

    handleImageUpload(event) {
        const file = event.target.files[0];
        if (!file) return;

        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif', 'image/webp', ''];
        if (!allowedTypes.includes(file.type)) {
            this.addMessage('ai', 'Please upload an image file (JPG, PNG, HEIC, or WebP).', false);
            return;
        }

        this.compressForPending(file);

        event.target.value = '';
    }

    compressForPending(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const MAX_SIZE = 800;
                let width = img.width;
                let height = img.height;
                if (width > height) {
                    if (width > MAX_SIZE) { height = Math.round(height * MAX_SIZE / width); width = MAX_SIZE; }
                } else {
                    if (height > MAX_SIZE) { width = Math.round(width * MAX_SIZE / height); height = MAX_SIZE; }
                }
                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                canvas.getContext('2d').drawImage(img, 0, 0, width, height);
                const compressed = canvas.toDataURL('image/png');
                this.pendingImagePreview = compressed;
                this.imageUrl = compressed;
                this.pendingImageBase64 = compressed.substring(compressed.indexOf(',') + 1);
                console.log('[VoiceAgentIOS] Image converted to PNG, size:', Math.round(this.pendingImageBase64.length * 0.75), 'bytes');
            };
            img.onerror = () => {
                this.pendingImageBase64 = null;
                this.pendingImagePreview = null;
                this.addMessage('ai', 'Failed to read the image. Please try again.', false);
            };
            img.src = e.target.result;
        };
        reader.onerror = () => {
            this.pendingImageBase64 = null;
            this.pendingImagePreview = null;
            this.addMessage('ai', 'Failed to read the image. Please try again.', false);
        };
        reader.readAsDataURL(file);
    }

    removePendingImage() {
        this.pendingImageBase64 = null;
        this.pendingImagePreview = null;
        this.imageUrl = null;
        this._capturedImageData = null;
        this._cameraMode = false;
    }

    async sendMessageWithPendingImage(userText) {
        const base64 = this.pendingImageBase64;
        const imagePreviewSnapshot = this.pendingImagePreview;

        this.pendingImageBase64 = null;
        this.pendingImagePreview = null;

        this.addMessage('user', userText || '', true, null, imagePreviewSnapshot);

        this.isProcessing = true;
        this.userInput = '';
        this.pauseRecognition();

        try {
            const analysisResult = await analyzeImageOnly({
                base64Image: base64,
                contentType: 'image/png',
                languageCode: this.selectedLanguage,
                voiceGender: this.getVoiceGender(this.selectedLanguage)
            });

            this.addMessage('ai', analysisResult.interimMessage, false);
            if (this.mode !== 'chat' && analysisResult.interimTtsAudio) {
                this.playBase64AudioIOSAdvanced(analysisResult.interimTtsAudio, analysisResult.interimMessage);
            }

            const agentMessage = 'Can you please convert this JSON into a clear, concise, and human-readable customer response, presented as a short summary in a casual and natural tone: ' + analysisResult.imageJson;

            const result = await callAgentforce({
                userMessage: agentMessage,
                sessionId: this.sessionId,
                languageCode: this.selectedLanguage,
                voiceGender: this.getVoiceGender(this.selectedLanguage),
                deviceType: this.deviceType,
                userId: this.userId
            });

            this.sessionId = result.sessionId;
            this.lastAgentOutput = result.agentResponse;
            this.addMessage('ai', result.agentResponse, false, result.callPhoneNumber);

            if (this.mode !== 'chat' && result.ttsAudio) {
                this.playBase64AudioIOSAdvanced(result.ttsAudio, result.agentResponse);
            }
        } catch (err) {
            console.error('[VoiceAgentIOS] Image+text send error:', err);
            this.addMessage('ai', 'Sorry, I could not process the image. Please try again.', false);
        } finally {
            this.isProcessing = false;
        }
    }

compressAndSend(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        const img = new Image();
        img.onload = async () => {
            const MAX_SIZE = 800;
            let width = img.width;
            let height = img.height;

            if (width > height) {
                if (width > MAX_SIZE) {
                    height = Math.round(height * MAX_SIZE / width);
                    width = MAX_SIZE;
                }
            } else {
                if (height > MAX_SIZE) {
                    width = Math.round(width * MAX_SIZE / height);
                    height = MAX_SIZE;
                }
            }

            const canvas = document.createElement('canvas');
            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, width, height);

            const compressedBase64 = canvas.toDataURL('image/png');
            const base64 = compressedBase64.substring(compressedBase64.indexOf(',') + 1);

            console.log('Original size:', file.size, 'bytes');
            console.log('Approx PNG size:', Math.round(base64.length * 0.75), 'bytes');

            await this.sendImageToAgent(base64, 'image/png');
        };
        img.onerror = () => {
            this.addMessage('ai', 'Failed to read the image. Please try again.', false);
        };
        img.src = e.target.result;
    };
    reader.onerror = () => {
        this.addMessage('ai', 'Failed to read the image. Please try again.', false);
    };
    reader.readAsDataURL(file);
}

    async sendImageToAgent(base64Image, contentType) {
        this.isProcessing = true;
        this.pauseRecognition();

        try {
        const analysisResult = await analyzeImageOnly({
            base64Image,
            contentType,
            languageCode: this.selectedLanguage,
            voiceGender: this.getVoiceGender(this.selectedLanguage)
        });

        this.addMessage('ai', analysisResult.interimMessage, false);
        if (this.mode !== 'chat' && analysisResult.interimTtsAudio) {
            this.playBase64AudioIOSAdvanced(analysisResult.interimTtsAudio, analysisResult.interimMessage);
        }

        const agentMessage = 'Can you please convert this JSON into a clear, concise, and human-readable customer response, presented as a short summary in a casual and natural tone: ' + analysisResult.imageJson;

        const result = await callAgentforce({
            userMessage: agentMessage,
            sessionId: this.sessionId,
            languageCode: this.selectedLanguage,
            voiceGender: this.getVoiceGender(this.selectedLanguage),
            deviceType: this.deviceType,
            userId: this.userId
        });

        this.sessionId = result.sessionId;
        this.lastAgentOutput = result.agentResponse;
        this.addMessage('ai', result.agentResponse, false, result.callPhoneNumber);

        if (this.mode !== 'chat' && result.ttsAudio) {
            this.playBase64AudioIOSAdvanced(result.ttsAudio, result.agentResponse);
        }

    } catch (err) {
        console.error('[VoiceAgentIOS] Image upload error:', err);
        this.addMessage('ai', 'Sorry, I could not process the image. Please try again.', false);
    } finally {
        this.isProcessing = false;
    }
}

    activateCameraMode() {
        console.log('[VoiceAgentIOS] Activating camera mode');
        this._cameraMode = true;
        this.pauseRecognition();
        this.addMessage('ai', '📷 Tap the camera icon to take a photo, then describe it.', false);
    }

    handleCameraCaptureInVoiceMode(event) {
        const file = event.target.files[0];
        if (!file) return;

        console.log('[VoiceAgentIOS] Camera capture in voice mode:', file.name);
        
        const allowedTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif', 'image/webp', ''];
        if (!allowedTypes.includes(file.type)) {
            this.addMessage('ai', 'Please capture an image file (JPG, PNG, HEIC, or WebP).', false);
            this._cameraMode = false;
            this.resumeRecognition();
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const MAX_SIZE = 800;
                let width = img.width;
                let height = img.height;

                if (width > height) {
                    if (width > MAX_SIZE) {
                        height = Math.round(height * MAX_SIZE / width);
                        width = MAX_SIZE;
                    }
                } else {
                    if (height > MAX_SIZE) {
                        width = Math.round(width * MAX_SIZE / height);
                        height = MAX_SIZE;
                    }
                }

                const canvas = document.createElement('canvas');
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                const compressedBase64 = canvas.toDataURL('image/png');
                this._capturedImageData = compressedBase64.substring(compressedBase64.indexOf(',') + 1);
                
                this.imageUrl = compressedBase64;
                this.pendingImagePreview = compressedBase64;
                
                console.log('[VoiceAgentIOS] Photo staged. Waiting for voice description...');
                
                this.resumeRecognition();
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
        
        event.target.value = '';
    }

    async sendImageWithVoiceDescription(voiceText) {
        if (!this._capturedImageData) {
            console.warn('[VoiceAgentIOS] No captured image data');
            return;
        }

        const imageDataSnapshot = this._capturedImageData;
        const imagePreviewSnapshot = this.pendingImagePreview || this.imageUrl;

        this._cameraMode = false;
        this._capturedImageData = null;
        this.pendingImagePreview = null;

        this.isProcessing = true;
        console.log('[VoiceAgentIOS] Sending image + voice description');

        this.addMessage('user', voiceText || '', true, null, imagePreviewSnapshot);

        try {
            const analysisResult = await analyzeImageOnly({
                base64Image: imageDataSnapshot,
                contentType: 'image/png',
                languageCode: this.selectedLanguage,
                voiceGender: this.getVoiceGender(this.selectedLanguage)
            });

            this.addMessage('ai', analysisResult.interimMessage, false);
            if (analysisResult.interimTtsAudio) {
                this.playBase64AudioIOSAdvanced(analysisResult.interimTtsAudio, analysisResult.interimMessage);
            }

            const agentMessage = 'Can you please convert this JSON into a clear, concise, and human-readable customer response, presented as a short summary in a casual and natural tone: ' + analysisResult.imageJson;

            const result = await callAgentforce({
                userMessage: agentMessage,
                sessionId: this.sessionId,
                languageCode: this.selectedLanguage,
                voiceGender: this.getVoiceGender(this.selectedLanguage),
                deviceType: this.deviceType,
                userId: this.userId
            });

            this.sessionId = result.sessionId;
            this.lastAgentOutput = result.agentResponse;
            this.addMessage('ai', result.agentResponse, false, result.callPhoneNumber);

            if (result.ttsAudio) {
                this.playBase64AudioIOSAdvanced(result.ttsAudio, result.agentResponse);
            }

        } catch (err) {
            console.error('[VoiceAgentIOS] Image+voice send error:', err);
            this.addMessage('ai', 'Sorry, I could not process the image with voice. Please try again.', false);
        } finally {
            this.isProcessing = false;
        }
    }

    handleKeyPress(e) {
        if (e.key === 'Enter') {
            this.handleSend();
        }
    }

    addMessage(from, text, isImage, callPhoneNumber = null, imageUrl = null) {
        const mapUrls = from === 'ai' ? this.extractMapData(text) : [];
        const linkUrls = from === 'ai' ? this.extractLinkUrls(text, mapUrls) : [];
        const message = {
            id: Date.now(),
            from,
            text,
            timestamp: new Date().getTime(),
            isImage: isImage,
            imageUrl: imageUrl || null,
            mapUrls,
            hasMapUrls: mapUrls.length > 0,
            linkUrls,
            hasLinkUrls: linkUrls.length > 0
        };
        this.messages = [...this.messages, message];
        this.scrollToBottom();

        if (from === 'ai') {
            this.voiceMapCards = mapUrls;
        }

        if (from === 'ai') {
            this.handleAIMessageActions(text, callPhoneNumber);
        }
    }

    handleAIMessageActions(text, callPhoneNumber) {
        if (callPhoneNumber || text?.toLowerCase().includes('you can now make a call') || text?.toLowerCase().includes('the call is being made')) {
            const phone = callPhoneNumber ? callPhoneNumber : '1234567890';
            console.log('[VoiceAgentIOS-FSL] Initiating phone call:', phone);
            this.openExternalUrl(`tel:${phone}`);
        }

    }

    containsMapUrl(text) {
        if (!text) return false;
        const mapUrlMatch = text.match(/https?:\/\/(maps\.app\.goo\.gl\/[\w\d]+)/i);
        
        return mapUrlMatch && mapUrlMatch[0];
    }

    openMapsApp(text) {
        const mapUrlMatch = text.match(/https?:\/\/(maps\.app\.goo\.gl\/[\w\d]+)/i);
        
        if (mapUrlMatch && mapUrlMatch[0]) {
            const latitude = 40.7929347;
            const longitude = -73.6968988;
            const locationName = "Northern Blvd, New York, USA";
            const zoom = 17;

            const appleMapsUrl = `https://maps.apple.com/?ll=${latitude},${longitude}&q=${encodeURIComponent(locationName)}&z=${zoom}`;
            console.log('[VoiceAgentIOS-FSL] Opening Apple Maps via universal link:', appleMapsUrl);
            this.openExternalUrl(appleMapsUrl);
        }
    }

    openExternalUrl(url) {
        try {
            console.log('[VoiceAgentIOS-FSL] openExternalUrl:', url);

            const anchor = document.createElement('a');
            anchor.setAttribute('href', url);
            anchor.setAttribute('target', '_blank');
            anchor.setAttribute('rel', 'noopener noreferrer');
            anchor.style.display = 'none';
            document.body.appendChild(anchor);
            anchor.click();

            setTimeout(() => {
                if (anchor.parentNode) {
                    anchor.parentNode.removeChild(anchor);
                }
            }, 100);

        } catch (error) {
            console.error('[VoiceAgentIOS-FSL] openExternalUrl failed:', error);
            try {
                window.open(url, '_blank');
            } catch (e2) {
                console.error('[VoiceAgentIOS-FSL] window.open fallback also failed:', e2);
            }
        }
    }

    scrollToBottom() {
        setTimeout(() => {
            const chatContainer = this.template.querySelector('.chat-messages');
            if (chatContainer) {
                chatContainer.scrollTop = chatContainer.scrollHeight;
            }
        }, 100);
    }

    async sendMessage() {
        const userMessage = this.userInput.trim();
        if (!userMessage) return;

        console.log('[VoiceAgentIOS] Sending message in language:', this.selectedLanguage, '| Message:', userMessage);
        this.addMessage('user', userMessage, false);

        this.isProcessing = true;
        this._partialTranscript = '';
        this.voiceMapCards = [];

        this.userInput = '';
        this.pauseRecognition();

        try {
            const result = await callAgentforce({
                userMessage,
                sessionId: this.sessionId,
                languageCode: this.selectedLanguage,
                voiceGender: this.getVoiceGender(this.selectedLanguage),
                deviceType: this.deviceType,
                userId: this.userId
            });

            this.sessionId = result.sessionId;
            this.lastAgentOutput = result.agentResponse;
            this.addMessage('ai', result.agentResponse, false, result.callPhoneNumber);

            if (this.mode !== 'chat') {
                if (!this.useSpeechSynthesis && result.ttsAudio) {
                    this.playBase64AudioIOSAdvanced(result.ttsAudio, result.agentResponse);
                } else {
                    this.speakTextIOS(result.agentResponse);
                }
            }

            this.isProcessing = false;
        } catch (err) {
            console.error('iOS sendMessage error:', err);
            this.isProcessing = false;
            this.addMessage('ai', 'Sorry, I encountered an error. Please try again.', false);
        }
    }

    async switchToListening() {
        this.mode = 'listening';
        this._userGestureContext = true;

        this.isProcessing = false;
        this.isSpeaking = false;
        this._voiceRecognitionRestartAttempts = 0;
        this._partialTranscript = '';

        if (this._currentAudio) {
            this._currentAudio.pause();
            this._currentAudio = null;
        }

        this.initializeIOSAudioSync();
        this.startVoiceInput();

        this.enableScreenWakeLock();

        if (this._iosAudioContext && this._iosAudioContext.state === 'suspended') {
            try {
                await this._iosAudioContext.resume();
                console.log('[VoiceAgentIOS] AudioContext resumed for greeting');
            } catch (e) {
                console.warn('[VoiceAgentIOS] AudioContext resume for greeting failed:', e);
            }
        }

        let greetName = this.userFirstName ? this.userFirstName : 'there';
        const greetings = {
            'en-US': `Hi ${greetName}, How may I help you today?`,
            'de-DE': `Hallo ${greetName}, wie kann ich Ihnen heute helfen?`,
            'ja-JP': `${greetName}さん、どのようにお手伝いできますか？`,
            'hi-IN': `नमस्ते ${greetName}, मैं आज आपकी कैसे मदद कर सकती हूँ?`
        };

        let greeting = greetings[this.selectedLanguage] || greetings['en-US'];

        this._lastLangGreetings = this.selectedLanguage;
        if (!this.useSpeechSynthesis) {
            try {
                if (this.greetingVoices[this.selectedLanguage]) {
                    this.playBase64AudioIOSAdvanced(this.greetingVoices[this.selectedLanguage], greeting);
                } else {
                    this.isProcessing = true;
                    const result = await callAgentforce({
                        userMessage: greeting,
                        sessionId: this.sessionId,
                        languageCode: this.selectedLanguage,
                        voiceGender: this.getVoiceGender(this.selectedLanguage),
                        deviceType: this.deviceType
                    });
                    this.isProcessing = false;
                    if (result && result.ttsAudio) {
                        this.playBase64AudioIOSAdvanced(result.ttsAudio, greeting);
                    }
                }
            } catch (e) {
                this.isProcessing = false;
                this.debugMessage = 'Error fetching greeting audio: ' + (e && e.message ? e.message : e);
            }
        } else {
            this.speakTextIOS(greeting, 1, true);
        }
    }

    switchToChat() {
        this.mode = 'chat';
        if (this._currentAudio) {
            this._currentAudio.pause();
            this._currentAudio = null;
        }
        this.stopVoiceInput();
        this.stopAllAudioAndSpeech();
        this.stopAmplitudeDetection();
        this.resetAmplitudeBars();

        this._cameraMode = false;
        this._capturedImageData = null;

        this.pendingImageBase64 = null;
        this.pendingImagePreview = null;

        this.disableScreenWakeLock();

        this.voiceMapCards = [];

    }

    toggleSettings() {
        this.showSettings = !this.showSettings;
    }

    handleLanguageChange(event) {
        this.selectedLanguage = event.detail.value;
        if (this.isListeningMode) {
            this.stopVoiceInput();
            setTimeout(() => this.startVoiceInput(), 100);
        }
    }

    get hasVoiceMapCards() {
        return this.voiceMapCards && this.voiceMapCards.length > 0;
    }

    get voiceMapGridClass() {
        const count = this.voiceMapCards ? this.voiceMapCards.length : 0;
        if (count === 1) return 'map-grid map-grid-1';
        if (count <= 4) return 'map-grid map-grid-2';
        return 'map-grid map-grid-3';
    }

    extractLinkUrls(text, mapUrls = []) {
        if (!text) return [];
        const mapUrlSet = new Set(mapUrls.map(m => m.url));
        const urlRegex = /https?:\/\/[^\s\])'"\n]+/g;
        const seen = new Set();
        const results = [];
        let match;
        let idx = 0;
        while ((match = urlRegex.exec(text)) !== null) {
            const url = match[0].replace(/[.,;!?)\[\]]+$/, '');
            if (!mapUrlSet.has(url) && !seen.has(url)) {
                seen.add(url);
                results.push({ id: `link-${Date.now()}-${idx}`, url });
                idx++;
            }
        }
        return results;
    }

    extractMapData(text) {
        if (!text) return [];
        const urlRegex = /https?:\/\/(?:maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.com|google\.com\/maps|maps\.apple\.com)[^\s\])"'\n]*/g;
        const results = [];
        let match;
        let idx = 0;

        while ((match = urlRegex.exec(text)) !== null) {
            let url = match[0].replace(/[.,;!?)[\]]+$/, '');
            let nameFromUrl = null;
            try {
                const u = new URL(url);
                const rawName = u.searchParams.get('name');
                if (rawName) {
                    nameFromUrl = decodeURIComponent(rawName.replace(/\+/g, ' ')).trim();
                }
                ['g_st', 'g_ep', 'entry', 'shorturl'].forEach(p => u.searchParams.delete(p));
                url = u.toString();
            } catch (e) { }

            if (nameFromUrl && nameFromUrl.length >= 2) {
                let name = nameFromUrl;
                if (name.length > 40) {
                    const cut = name.slice(0, 40).replace(/\s+\S*$/, '');
                    name = (cut.length > 5 ? cut : name.slice(0, 40)).trim() + '\u2026';
                }
                results.push({ id: `loc-${Date.now()}-${idx}`, name, url });
                idx++;
                continue;
            }

            const before = text.slice(Math.max(0, match.index - 400), match.index);
            let name = `Location ${idx + 1}`;

            const allBold = [...before.matchAll(/\*\*([^*\n]{1,80})\*\*/g)];
            if (allBold.length > 0) {
                name = allBold[allBold.length - 1][1].trim();
            } else {
                const allNumbered = [...before.matchAll(/(?:^|\n)\s*\d+[.)]\s+([^\n]{2,80})/g)];
                if (allNumbered.length > 0) {
                    name = allNumbered[allNumbered.length - 1][1].trim();
                } else {
                    const addressKeywords = /\b(address|addr|location|directions?|navigate|map|visit|view|click|tap|open|here|floor|road|marg|nagar|lane|street|city|pin|zip|ph:|tel:|phone|shop\s*no|plot\s*no)\b/i;
                    const lines = before.split('\n').map(l => l.trim()).reverse();
                    for (const line of lines) {
                        let candidate = line
                            .replace(/\*\*/g, '')
                            .replace(/^[-*•·\u2022\d.):\s]+/, '')
                            .replace(/[-:–—\s]+$/, '')
                            .replace(/\s+/g, ' ')
                            .trim();
                        if (
                            candidate.length >= 2 &&
                            candidate.length <= 60 &&
                            !addressKeywords.test(candidate) &&
                            !/https?:\/\//.test(candidate) &&
                            !/^\d+$/.test(candidate)
                        ) {
                            name = candidate;
                            break;
                        }
                    }
                }
            }

            name = name.replace(/[*_`[\]]/g, '').replace(/\s+/g, ' ').trim();
            if (name.length > 40) {
                const cut = name.slice(0, 40).replace(/\s+\S*$/, '');
                name = (cut.length > 5 ? cut : name.slice(0, 40)).trim() + '\u2026';
            }

            results.push({ id: `loc-${Date.now()}-${idx}`, name: name || `Location ${idx + 1}`, url });
            idx++;
        }
        return results;
    }

    dismissVoiceMapCard(event) {
        event.stopPropagation();
        const id = event.currentTarget.dataset.id;
        this.voiceMapCards = this.voiceMapCards.filter(c => c.id !== id);
    }

    handleLinkClick(event) {
        const url = event.currentTarget.dataset.url;
        if (!url) return;
        event.stopPropagation();
        this.openExternalUrl(url);
    }

    handleOpenLocation(event) {
        event.stopPropagation();
        const url = event.currentTarget.dataset.url;
        if (!url) return;
        console.log('[VoiceAgentIOS-FSL] handleOpenLocation:', url);
        this.openMapUrl(url);
    }

    openMapUrl(url) {
        console.log('[VoiceAgentIOS-FSL] openMapUrl:', url);
        try {
            this[NavigationMixin.Navigate]({
                type: 'standard__webPage',
                attributes: { url }
            });
        } catch (e) {
            console.warn('[VoiceAgentIOS-FSL] NavigationMixin.Navigate failed, falling back:', e);
            this.openExternalUrl(url);
        }
    }

    getVoiceGender(lang) {
        if (this.voiceGenderGetter) {
            return this.voiceGenderGetter(lang);
        }
        if (lang === 'ja-JP') return 'ja-JP-Chirp3-HD-Sulafat';
        if (lang === 'de-DE') return 'de-DE-Standard-A';
        if (lang === 'hi-IN') return 'hi-IN-Chirp3-HD-Sulafat';
        return 'en-US-Chirp3-HD-Sulafat';
    }

    speakTextIOS(text, vol = 1, noStatus = false) {
        try {
            if (!this.speechSynthesis) {
                this.debugMessage = 'SpeechSynthesis API not available (iOS).';
                return;
            }

            const cleanedText = text
                .replace(/[^\w\s.,!?]/g, '')
                .replace(/\s+/g, ' ')
                .trim();

            const voices = this.speechSynthesis.getVoices();
            const iosVoices = ['siri', 'Allison', 'kyoko', 'Ava', 'anna', 'kiyara'];
            let selectedVoice = null;

            selectedVoice = voices.find(v =>
                iosVoices.some(name => v.name.toLowerCase().includes(name)) && v.lang === this.selectedLanguage
            );

            if (!selectedVoice) {
                selectedVoice = voices.find(v =>
                    v.name.toLowerCase().includes('siri') && v.lang === this.selectedLanguage
                );
            }

            if (!selectedVoice) {
                selectedVoice = voices.find(v =>
                    v.lang && v.lang.startsWith(this.selectedLanguage.split('-')[0])
                );
            }

            if (!selectedVoice && voices.length > 0) {
                selectedVoice = voices[0];
            }

            const utterance = new SpeechSynthesisUtterance(cleanedText);
            this.currentUtterance = utterance;
            utterance.lang = this.selectedLanguage;
            utterance.volume = vol;
            utterance.rate = 0.7;
            utterance.pitch = 1;
            if (selectedVoice) {
                utterance.voice = selectedVoice;
            }

            this.ttsSubtitle = cleanedText;
            this.ttsWords = cleanedText.split(/\s+/).map(w => w.replace(/[.,!?;:()\[\]{}"'`~\-]/g, '')).filter(Boolean);
            this.ttsCurrentWordIndex = -1;

            utterance.onstart = () => {
                this.isSpeaking = true;
                this.pauseRecognition();
                this.stopVoiceInput();
                this._partialTranscript = '';
                clearTimeout(this._interimSilenceTimer);
                this.startTTSBlobAnimation();
            };

            utterance.onend = () => {
                this.isSpeaking = false;
                this.currentUtterance = null;
                this.stopTTSBlobAnimation();
                this.ttsSubtitle = '';
                this.ttsWords = [];
                this.ttsCurrentWordIndex = -1;
                this._partialTranscript = '';
                clearTimeout(this._interimSilenceTimer);

                setTimeout(() => {
                    if (this.isListeningMode && !this.isProcessing) {
                        this.startVoiceInput();
                    }
                }, 300);
            };

            utterance.onerror = (event) => {
                this.isSpeaking = false;
                this.currentUtterance = null;
                this.clearTranscriptState();
                let errorDetails = event.error;
                if (event.message) {
                    errorDetails += `- ${event.message}`;
                }
                this.debugMessage = `speakTextIOS: Speech Error: ${errorDetails}`;
                this.stopTTSBlobAnimation();

                setTimeout(() => {
                    if (this.isListeningMode && !this.isProcessing) {
                        this.startVoiceInput();
                    }
                }, 300);
            };

            utterance.onboundary = (event) => {
                if (event.name === 'word') {
                    const charIndex = event.charIndex;
                    let acc = 0;
                    for (let i = 0; i < this.ttsWords.length; i++) {
                        acc += this.ttsWords[i].length + 1;
                        if (charIndex < acc) {
                            this.ttsCurrentWordIndex = i;
                            break;
                        }
                    }
                }
            };

            this.speechSynthesis.speak(utterance);
        } catch (e) {
            this.debugMessage = `speakTextIOS: Speech Setup Error: ${e.message}`;
            this.isSpeaking = false;
            this.currentUtterance = null;
            this.stopTTSBlobAnimation();
        }
    }

    async initializeIOSAudio() {
        try {
            console.log('[VoiceAgentIOS] Initializing audio context during user gesture');

            if (!this._iosAudioContext || this._iosAudioContext.state === 'closed') {
                console.log('[VoiceAgentIOS] Creating new AudioContext');
                this._iosAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            }

            if (this._iosAudioContext.state === 'suspended') {
                await this._iosAudioContext.resume();
                console.log('[VoiceAgentIOS] AudioContext resumed');
            }

            if (this._iosAudioContext.state === 'running') {
                const silentBuffer = this._iosAudioContext.createBuffer(1, 1, 22050);
                const silentSource = this._iosAudioContext.createBufferSource();
                silentSource.buffer = silentBuffer;
                silentSource.connect(this._iosAudioContext.destination);
                silentSource.start();
                console.log('[VoiceAgentIOS] Audio context initialized and unlocked');
            }

            return true;
        } catch (error) {
            console.error('[VoiceAgentIOS] Failed to initialize audio context:', error);
            return false;
        }
    }

    initializeIOSAudioSync() {
        try {
            console.log('[VoiceAgentIOS] Initializing audio context synchronously (user gesture)');

            if (!this._iosAudioContext || this._iosAudioContext.state === 'closed') {
                console.log('[VoiceAgentIOS] Creating new AudioContext (sync)');
                this._iosAudioContext = new (window.AudioContext || window.webkitAudioContext)();
            }

            if (this._iosAudioContext.state === 'suspended') {
                this._iosAudioContext.resume().then(() => {
                    console.log('[VoiceAgentIOS] AudioContext resumed (sync path)');
                }).catch(e => {
                    console.warn('[VoiceAgentIOS] AudioContext resume failed (sync path):', e);
                });
            }

            if (this._iosAudioContext.state === 'running') {
                const silentBuffer = this._iosAudioContext.createBuffer(1, 1, 22050);
                const silentSource = this._iosAudioContext.createBufferSource();
                silentSource.buffer = silentBuffer;
                silentSource.connect(this._iosAudioContext.destination);
                silentSource.start();
                console.log('[VoiceAgentIOS] Silent buffer played — audio unlocked');
            }

            return true;
        } catch (error) {
            console.error('[VoiceAgentIOS] Failed to initialize audio context (sync):', error);
            return false;
        }
    }

    async playBase64AudioIOSAdvanced(base64Audio, fallbackText = null) {
        console.log('[VoiceAgentIOS] Attempting advanced audio playback');

        try {
            if (!this._iosAudioContext || this._iosAudioContext.state === 'closed') {
                console.log('[VoiceAgentIOS] AudioContext not available, using fallback');
                if (fallbackText) {
                    this.speakTextIOS(fallbackText);
                }
                return;
            }

            if (this._iosAudioContext.state === 'suspended') {
                try {
                    await this._iosAudioContext.resume();
                    console.log('[VoiceAgentIOS] AudioContext resumed for playback');
                } catch (e) {
                    console.log('[VoiceAgentIOS] Failed to resume AudioContext, using fallback');
                    if (fallbackText) {
                        this.speakTextIOS(fallbackText);
                    }
                    return;
                }
            }

            const audioData = this.base64ToArrayBuffer(base64Audio);
            const audioBuffer = await this._iosAudioContext.decodeAudioData(audioData);

            if (this._iosAudioSource) {
                try {
                    this._iosAudioSource.stop();
                } catch (e) { }
                this._iosAudioSource = null;
            }

            this._iosAudioSource = this._iosAudioContext.createBufferSource();
            this._iosAudioSource.buffer = audioBuffer;
            this._iosAudioSource.connect(this._iosAudioContext.destination);

            this.isSpeaking = true;
            this.pauseRecognition();
            this.startTTSBlobAnimation();

            this._iosAudioSource.onended = () => {
                console.log('[VoiceAgentIOS] Advanced audio playback ended');
                this.isSpeaking = false;
                this.stopTTSBlobAnimation();
                this._iosAudioSource = null;
                setTimeout(() => {
                    this.resumeRecognition();
                }, 500);
            };

            this._iosAudioSource.start();
            console.log('[VoiceAgentIOS] Advanced audio playback started');

        } catch (error) {
            console.error('[VoiceAgentIOS] Advanced audio playback failed:', error);

            this.isSpeaking = false;
            this.stopTTSBlobAnimation();
            this._iosAudioSource = null;

            if (fallbackText) {
                console.log('[VoiceAgentIOS] Using speech synthesis fallback');
            }
        }
    }

    base64ToArrayBuffer(base64) {
        const binaryString = atob(base64);
        const bytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
        }
        return bytes.buffer;
    }

    startVoiceInput() {
        if (this.recognition) {
            this.recognition.onresult = null;
            this.recognition.onerror = null;
            this.recognition.onend = null;
            try { this.recognition.stop(); } catch (e) { }
            this.recognition = null;
        }
        this._partialTranscript = '';
        this.recognitionActive = false;

        const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

        if (navigator.mediaDevices && window.AudioContext) {
            console.log('[VoiceAgentIOS] Using getUserMedia + AudioContext');
            if (this.recognitionActive || this._audioContext || this._microphone) {
                return;
            }

            navigator.mediaDevices.getUserMedia({ audio: true })
                .then(stream => {
                    this._mediaStream = stream;
                    this.startAmplitudeDetection(stream);
                    if (SpeechRecognition) {
                        this.recognition = new SpeechRecognition();
                        this.recognition.lang = this.recognitionLang;
                        this.recognition.interimResults = true;
                        this.recognition.continuous = true;
                        this.speechBuffer = '';
                        this.speechBufferTimeout = null;

                        this.recognition.onstart = () => {
                            this.recognitionActive = true;
                            this.blobActive = true;
                            this._voiceRecognitionRestartAttempts = 0;
                            console.log('[VoiceAgentIOS] Mic is now listening. Language:', this.recognition.lang);
                        };

                        this.recognition.onresult = this.handleResult.bind(this);

                        this.recognition.onerror = (evt) => {
                            if (evt.error === 'no-speech' || evt.error === 'aborted') {
                                return;
                            }
                            console.error('iOS Speech recognition error:', evt.error);
                            this.blobActive = false;
                            this.switchToChat();
                        };

                        this.recognition.onend = () => {
                            this.recognitionActive = false;
                            if (this.mode === 'listening' && !this.isProcessing && !this.isSpeaking) {
                                this.restartVoiceRecognition();
                            }
                        };

                        this.defaultRecognitionOnEnd = this.recognition.onend;

                        try {
                            this.recognition.start();
                        } catch (error) {
                            this.blobActive = false;
                            this.switchToChat();
                        }
                    } else {
                        this.switchToChat();
                    }
                })
                .catch(err => {
                    this.debugMessage = 'Mic permission denied or error: ' + err;
                    this.switchToChat();
                });
        } else if (SpeechRecognition) {
            console.log('[VoiceAgentIOS] Using basic SpeechRecognition');
            if (this.recognitionActive) {
                return;
            }

            this.recognition = new SpeechRecognition();
            this.recognition.lang = this.recognitionLang;
            this.recognition.interimResults = true;
            this.recognition.continuous = true;
            this.speechBuffer = '';
            this.speechBufferTimeout = null;

            this.recognition.onstart = () => {
                this.recognitionActive = true;
                this.blobActive = true;
                this._voiceRecognitionRestartAttempts = 0;
                console.log('[VoiceAgentIOS] Mic is now listening. Language:', this.recognition.lang);
            };

            this.recognition.onresult = this.handleResult.bind(this);

            this.recognition.onerror = (evt) => {
                if (evt.error === 'no-speech' || evt.error === 'aborted') {
                    return;
                }
                console.error('iOS Speech recognition error:', evt.error);
                this.blobActive = false;
                this.switchToChat();
            };

            this.recognition.onend = () => {
                this.recognitionActive = false;
                if (this.mode === 'listening' && !this.isProcessing && !this.isSpeaking) {
                    this.restartVoiceRecognition();
                }
            };

            this.defaultRecognitionOnEnd = this.recognition.onend;

            try {
                this.recognition.start();
            } catch (error) {
                this.blobActive = false;
                this.switchToChat();
            }

            this.startAmplitudeDetection();
        } else {
            console.log('[VoiceAgentIOS] No SpeechRecognition available, switching to chat');
            this.switchToChat();
        }
    }

    restartVoiceRecognition() {
        if (this.recognition && !this.recognitionActive) {
            if (this._voiceRecognitionRestartAttempts >= this._maxRestartAttempts) {
                console.warn('[VoiceAgentIOS] Max restart attempts reached, reinitializing voice input');
                this._voiceRecognitionRestartAttempts = 0;
                this.stopVoiceInput();
                setTimeout(() => {
                    if (this.mode === 'listening') {
                        this.startVoiceInput();
                    }
                }, 500);
                return;
            }

            try {
                this._voiceRecognitionRestartAttempts++;
                setTimeout(() => {
                    if (this.mode === 'listening' && !this.recognitionActive) {
                        console.log('[VoiceAgentIOS] Restarting recognition, attempt:', this._voiceRecognitionRestartAttempts);
                        this.recognition.start();
                    }
                }, 100);
            } catch (error) {
                console.error('Error restarting voice recognition:', error);
                this.stopVoiceInput();
                setTimeout(() => {
                    if (this.mode === 'listening') {
                        this.startVoiceInput();
                    }
                }, 500);
            }
        }
    }

    stopVoiceInput() {
        if (this.recognition) {
            this.recognition.stop();
            this.recognitionActive = false;
        }
        if (this.speechSynthesis && this.isSpeaking) {
            if (typeof this.speechSynthesis.cancel === 'function') {
                this.speechSynthesis?.cancel();
            }
        }
        if (this.speechKeepAliveInterval) {
            clearInterval(this.speechKeepAliveInterval);
            this.speechKeepAliveInterval = null;
        }
        this.blobActive = false;
        if (this.speechEndTimeout) {
            clearTimeout(this.speechEndTimeout);
            this.speechEndTimeout = null;
        }
        this.stopAmplitudeDetection();
        this.resetAmplitudeBars();

        if (this._iosAudioSource) {
            try {
                this._iosAudioSource.stop();
            } catch (e) { }
            this._iosAudioSource = null;
        }

        if (this._mediaStream) {
            this._mediaStream.getTracks().forEach(track => track.stop());
            this._mediaStream = null;
        }
    }

    stopAllAudioAndSpeech() {
        if (this._currentAudio) {
            this._currentAudio.pause();
            this._currentAudio.currentTime = 0;
            this._currentAudio = null;
        }
        if (this.speechSynthesis && typeof this.speechSynthesis.cancel === 'function') {
            this.speechSynthesis?.cancel();
        }
        this.isSpeaking = false;
    }

    handleResult(evt) {
        if (!this.isListeningMode || this.isSpeaking || this.isProcessing) {
            this._partialTranscript = '';
            clearTimeout(this._interimSilenceTimer);
            console.log('[VoiceAgentIOS] Ignoring speech - Mode:', this.mode, 'Speaking:', this.isSpeaking, 'Processing:', this.isProcessing);
            return;
        }

        let transcript = '';
        for (let i = evt.resultIndex; i < evt.results.length; ++i) {
            const transcriptPiece = evt.results[i][0].transcript;
            const confidence = evt.results[i][0].confidence;

            if (evt.results[i].isFinal && confidence < 0.5) {
                console.warn('Low-confidence result, skipping:', transcriptPiece);
                continue;
            }

            transcript += evt.results[i][0].transcript;
            if (evt.results[i].isFinal) {
                const finalTranscript = transcript.trim().toLowerCase();
                console.log('[VoiceAgentIOS] Final transcript:', finalTranscript, 'Confidence:', confidence);

                if (this.checkForVoiceCommands(finalTranscript)) {
                    this._partialTranscript = '';
                    clearTimeout(this._interimSilenceTimer);
                    return;
                }

                if (!this.isSpeaking && !this.isProcessing) {
                    this.flushTranscript(transcript.trim());
                } else {
                    console.log('[VoiceAgentIOS] Ignoring final transcript - Speaking:', this.isSpeaking, 'Processing:', this.isProcessing);
                }
                return;
            }
        }

        this._partialTranscript = transcript.trim();

        const partialLower = this._partialTranscript.toLowerCase();
        if (this.checkForVoiceCommands(partialLower)) {
            this._partialTranscript = '';
            clearTimeout(this._interimSilenceTimer);
            return;
        }

        if (!this.isSpeaking && !this.isProcessing) {
            clearTimeout(this._interimSilenceTimer);
            this._interimSilenceTimer = setTimeout(() => {
                if (this._partialTranscript && !this.isSpeaking && !this.isProcessing) {
                    this.flushTranscript(this._partialTranscript);
                    this._partialTranscript = '';
                }
            }, SILENCE_TIMEOUT_MS);
        } else {
            console.log('[VoiceAgentIOS] Ignoring partial transcript - Speaking:', this.isSpeaking, 'Processing:', this.isProcessing);
        }
    }

    flushTranscript(text) {
        if (!text || this.isProcessing || this.isSpeaking) {
            console.log('[VoiceAgentIOS] Skipping transcript flush - invalid state');
            return;
        }
        console.log('[VoiceAgentIOS] Recognised:', text, '| lang:', this.recognition.lang);
        
        if (this._capturedImageData) {
            console.log('[VoiceAgentIOS] Staged image found: sending image with voice description');
            this.sendImageWithVoiceDescription(text);
        } else {
            this.userInput = text;
            this.sendMessage();
            this.userInput = '';
        }
        
        this._partialTranscript = '';
        clearTimeout(this._interimSilenceTimer);
    }

    pauseRecognition() {
        if (this.recognitionActive && this.recognition) {
            try { this.recognition.stop(); } catch (e) { }
            this.recognitionActive = false;
        }
        this._partialTranscript = '';
        clearTimeout(this._interimSilenceTimer);
        this._interimSilenceTimer = null;
    }

    resumeRecognition() {
        if (this.mode === 'listening' && this.recognition && !this.recognitionActive) {
            this._partialTranscript = '';
            try { this.recognition.start(); } catch (e) { }
        }
    }

    checkForVoiceCommands(transcript) {
        const lowerTranscript = transcript.toLowerCase().trim();

        if (!lowerTranscript) {
            return false;
        }

        for (const [command, action] of Object.entries(this.voiceCommands)) {
            if (lowerTranscript.includes(command)) {
                this.executeCommand(action);
                return true;
            }
        }

        return false;
    }

    executeCommand(command) {
        const commandHandlers = {
            'switchToChat': () => {
                console.log('[VoiceAgentIOS] Voice command detected: switching to chat mode');
                this.switchToChat();
            },
            'activateCamera': () => {
                console.log('[VoiceAgentIOS] Voice command detected: activating camera');
                this.activateCameraMode();
            }
        };

        const handler = commandHandlers[command];
        if (handler) {
            try {
                handler();
            } catch (error) {
                console.error('[VoiceAgentIOS] Error executing command:', command, error);
            }
        } else {
            console.warn('[VoiceAgentIOS] Unknown command:', command);
        }
    }

    updateBlobAmplitude(amplitude) {
        const amplitudeBars = this.template.querySelectorAll('.amplitude-bar');
        if (amplitudeBars.length > 0) {
            const maxHeight = 50;
            const minHeight = 8;
            const normalizedAmplitude = Math.min(Math.max(amplitude, 0), 1);
            
            const centerIndex = Math.floor(amplitudeBars.length / 2);
            
            amplitudeBars.forEach((bar, index) => {
                const distanceFromCenter = Math.abs(index - centerIndex);
                const waveEffect = Math.max(0, 1 - (distanceFromCenter / centerIndex) * 0.3);
                
                const randomFactor = 0.8 + (Math.random() * 0.4);
                
                const baseHeight = minHeight + (maxHeight - minHeight) * normalizedAmplitude * waveEffect * randomFactor;
                const finalHeight = Math.max(minHeight, Math.min(maxHeight, baseHeight));
                
                bar.style.height = `${finalHeight}px`;
                
                bar.style.background = `white`;
            });
        }
    }

    startAmplitudeDetection(stream) {
        if (this._audioContext || this._microphone) return;
        if (!navigator.mediaDevices || !window.AudioContext) return;

        const setup = (audioStream) => {
            if (this._iosAudioContext && this._iosAudioContext.state !== 'closed') {
                this._audioContext = this._iosAudioContext;
            } else {
                this._audioContext = new (window.AudioContext || window.webkitAudioContext)();
            }
            this._analyser = this._audioContext.createAnalyser();
            this._microphone = this._audioContext.createMediaStreamSource(audioStream);
            this._microphone.connect(this._analyser);
            this._analyser.fftSize = 256;
            this._amplitudeData = new Uint8Array(this._analyser.frequencyBinCount);

            const animate = () => {
                if (!this._analyser) return;
                
                this._analyser.getByteFrequencyData(this._amplitudeData);
                let sum = 0;
                let count = 0;
                
                const minBin = Math.floor((85 / 11000) * this._amplitudeData.length);
                const maxBin = Math.floor((3400 / 11000) * this._amplitudeData.length);
                
                for (let i = minBin; i < maxBin && i < this._amplitudeData.length; i++) {
                    sum += this._amplitudeData[i] / 255;
                    count++;
                }
                
                if (count > 0) {
                    const amplitude = sum / count;
                    const amplifiedAmplitude = Math.min(amplitude * 2.5, 1);
                    this.updateBlobAmplitude(amplifiedAmplitude);
                }
                
                this._amplitudeAnimFrame = requestAnimationFrame(animate);
            };
            animate();
        };

        if (stream) {
            setup(stream);
        } else {
            navigator.mediaDevices.getUserMedia({ audio: true }).then(setup);
        }
    }

    stopAmplitudeDetection() {
        if (this._amplitudeAnimFrame) {
            cancelAnimationFrame(this._amplitudeAnimFrame);
            this._amplitudeAnimFrame = null;
        }
        if (this._audioContext && this._audioContext !== this._iosAudioContext) {
            this._audioContext.close();
        }
        this._audioContext = null;
        this._analyser = null;
        this._microphone = null;
        this._amplitudeData = null;
    }

    resetAmplitudeBars() {
        const amplitudeBars = this.template.querySelectorAll('.amplitude-bar');
        if (amplitudeBars.length > 0) {
            amplitudeBars.forEach(bar => {
                bar.style.height = '8px';
                bar.style.background = 'white';
            });
        }
    }

    startTTSBlobAnimation() {
        const amplitudeBars = this.template.querySelectorAll('.amplitude-bar');
        if (!amplitudeBars.length) return;

        let running = true;
        const animate = () => {
            if (!running) return;
            amplitudeBars.forEach((bar, index) => {
                const height = 8 + Math.random() * 40;
                bar.style.height = `${height}px`;
                bar.style.background = `white`;
            });
            this._ttsAnimFrame = requestAnimationFrame(animate);
        };
        animate();

        this._stopTTSBlobAnimation = () => {
            running = false;
            if (this._ttsAnimFrame) cancelAnimationFrame(this._ttsAnimFrame);
            this.resetAmplitudeBars();
        };
    }

    stopTTSBlobAnimation() {
        if (this._stopTTSBlobAnimation) {
            this._stopTTSBlobAnimation();
            this._stopTTSBlobAnimation = null;
        }
    }
}
