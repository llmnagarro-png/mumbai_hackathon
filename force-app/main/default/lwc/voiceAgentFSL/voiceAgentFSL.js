import { LightningElement, track, wire } from 'lwc';
import { GREETING_VOICES, PROCESSING_VOICES } from './constants.js';
import FORM_FACTOR from '@salesforce/client/formFactor'
import { loadStyle } from 'lightning/platformResourceLoader';
import icomoon from '@salesforce/resourceUrl/icomoon';
import USER_ID from '@salesforce/user/Id';
import { getRecord } from 'lightning/uiRecordApi';
import callAgentforce from '@salesforce/apex/AgentforceController.callAgentforce';

const USER_FIELDS = ['User.FirstName','User.Id'];

export default class VoiceAgentFSL extends LightningElement {
    @track isDesktop = FORM_FACTOR === 'Large'
    @track selectedLanguage = 'en-US';
    @track isSessionInitializing = false;
    @track sessionInitMessage = '';
    @track userId = '';
    
    sessionId = null;
    userFirstName = '';


    @wire(getRecord, { recordId: USER_ID, fields: USER_FIELDS })
    wiredUser({ error, data }) {
        if (data && data.fields && data.fields.FirstName) {
            this.userFirstName = data.fields.FirstName.value;
            this.userId = data.fields.Id.value;
            console.log('OUTPUT : ',this.userId);
        } else {
            this.userFirstName = '';
        }
    }

    get devicePlatform() {
        const userAgent = navigator.userAgent || navigator.vendor || window.opera;
        
        if (/iPad|iPhone|iPod/.test(userAgent)) {
            return 'IOS';
        }
        
        if (/Android/.test(userAgent)) {
            return 'ANDROID';
        }
        
        if (/Mobile|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(userAgent)) {
            return 'MOBILE';
        }
        
        return 'DESKTOP';
    }

    get deviceType() {
        if (FORM_FACTOR === 'Large') return 'DESKTOP';
        if (FORM_FACTOR === 'Medium') return 'TABLET';
        return 'PHONE';
    }

    get isIOSDevice() {
        return this.devicePlatform === 'IOS';
    }

    get isAndroidDevice() {
        return this.devicePlatform === 'ANDROID';
    }

    get isDesktopDevice() {
        return this.devicePlatform === 'DESKTOP';
    }

    get greetingVoices() {
        return GREETING_VOICES;
    }

    get processingVoices() {
        return PROCESSING_VOICES;
    }

    get getVoiceGender() {
        return (lang) => {
            if (lang === 'ja-JP') return 'ja-JP-Chirp3-HD-Sulafat';
            if (lang === 'de-DE') return 'de-DE-Standard-A';
            if (lang === 'hi-IN') return 'hi-IN-Chirp3-HD-Sulafat';
            return 'en-US-Chirp3-HD-Sulafat';
        };
    }

    connectedCallback() {
    loadStyle(this, icomoon + '/style.css');
    this.initializeSession();
    
    window.addEventListener('error', (event) => {
        if (event.message?.includes('copilot') || 
            event.message?.includes('Refresh the conversation')) {
            event.preventDefault(); // suppress
        }
    });
}

    async initializeSession() {
        this.isSessionInitializing = true;
        this.sessionInitMessage = 'Connecting with Retail Assist...';

        try {
            const result = await callAgentforce({
                userMessage: '__init__',
                sessionId: null,
                languageCode: this.selectedLanguage,
                voiceGender: this.getVoiceGender(this.selectedLanguage),
                deviceType: this.deviceType,
                userId: this.userId
                
            });
            
            this.sessionId = result.sessionId;
            console.log('Session ID received:', result.sessionId);
            this.isSessionInitializing = false;
            this.sessionInitMessage = '';
        } catch (err) {
            this.isSessionInitializing = false;
            this.sessionInitMessage = 'Failed to initiate session. Please refresh.';
            console.error('Session init error:', err);
        }
    }
}