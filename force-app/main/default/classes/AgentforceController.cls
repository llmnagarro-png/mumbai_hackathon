public with sharing class AgentforceController {
    
    @AuraEnabled(cacheable=false)
    public static Map<String, String> analyzeImageOnly(String base64Image, String contentType, String languageCode, String voiceGender) {
        try {
            Blob imageBlob = EncodingUtil.base64Decode(base64Image);
            String imageJson = ImageAnalyzeUtil.analyzeImage(imageBlob, contentType);
            
            String interimMessage = 'I have completed the image analysis, now I am generating a summary of the analysis.';
            String interimTtsAudio = '';
            try {
                interimTtsAudio = getTTSBase64Audio(interimMessage, languageCode, voiceGender, 'MP3');
            } catch (Exception e) {
                System.debug('TTS interim message error: ' + e.getMessage());
            }
            
            return new Map<String, String>{
                'imageJson'       => imageJson,
                'interimMessage'  => interimMessage,
                'interimTtsAudio' => interimTtsAudio
            };
        } catch (Exception e) {
            System.debug('analyzeImageOnly error: ' + e.getMessage());
            throw new AuraHandledException(e.getMessage());
        }
    }
    
    @AuraEnabled(cacheable=false)
    public static Map<String, String> callAgentforceWithImage(
        String base64Image,
    String contentType,
    String sessionId,
    String languageCode,
    String voiceGender,
    String deviceType,
    String userMessage
    ) {
        try {
            // ✅ Convert base64 to Blob and use ImageAnalyzeUtil
            Blob imageBlob = null;
            String apiResponse = null;
            String finalMessage = 'User said: ' + userMessage;
            if(String.isNotBlank(base64Image)){
                imageBlob = EncodingUtil.base64Decode(base64Image);
                System.debug('Image blob size: ' + imageBlob.size() + ' bytes');
                
                apiResponse = ImageAnalyzeUtil.analyzeImage(imageBlob, contentType);
                System.debug('API Response: ' + apiResponse);
            }
            
            // Step 2 - Pass response to Agentforce
            Invocable.Action action = Invocable.Action.createCustomAction(
                // 'generateAiAgentResponse', 'Agentforce_Service_Agent'
            'generateAiAgentResponse', 'Consumer_Goods_Specialist_Agent'
                );
            
            if(string.isNotBlank(apiResponse))
                finalMessage = 'Can you please convert this JSON into a clear, concise, and human-readable customer response, presented as a short summary in a casual and natural tone: ' + apiResponse;
            
            System.debug('final message: '+finalMessage);
            
            action.setInvocationParameter('userMessage', finalMessage);
            
            if (String.isNotBlank(sessionId)) {
                action.setInvocationParameter('sessionId', sessionId);
            }
            
            List<Invocable.Action.Result> results = action.invoke();
            
            String agentResponse = '';
            String sessionIdOut = sessionId;
            
            if (!results.isEmpty() && results[0].isSuccess()) {
                Map<String, Object> outputParams = results[0].getOutputParameters();
                String agentResponseJson = (String) outputParams.get('agentResponse');
                Map<String, Object> responseMap = (Map<String, Object>) JSON.deserializeUntyped(agentResponseJson);
                agentResponse = (String) responseMap.get('value');
                sessionIdOut = (String) outputParams.get('sessionId');
            } else {
                system.debug('agentforce error:- ' + ((results[0].getErrors()[0])).getMessage());
                agentResponse = 'Sorry, agent is not available at this moment.';
            }
            
            // Step 3 - TTS
            String ttsAudio = '';
            try {
                ttsAudio = getTTSBase64Audio(stripUrlsForTTS(agentResponse), languageCode, voiceGender, 'MP3');
            } catch (Exception e) {
                ttsAudio = '';
            }
            
            return new Map<String, String>{
                'sessionId' => sessionIdOut,
                'agentResponse' => agentResponse,
                'ttsAudio' => ttsAudio,
                'callPhoneNumber' => ''
            };
            
        } catch (Exception e) {
            System.debug('callAgentforceWithImage error: ' + e.getMessage());
            throw new AuraHandledException(e.getMessage());
        }
    }
    
    // Above method is new
    @AuraEnabled(cacheable=false)
    public static Map<String, String> callAgentforce(String userMessage, String sessionId, String languageCode, String voiceGender, String deviceType,String userId) {
        String agentResponse = '';
        String sessionIdOut = sessionId;

        Invocable.Action action = Invocable.Action.createCustomAction(
            'generateAiAgentResponse', 'Consumer_Goods_Specialist_Agent'
        );
        action.setInvocationParameter('userMessage', userMessage);
        if (String.isNotBlank(sessionId)) {
            action.setInvocationParameter('sessionId', sessionId);
        }
        List<Invocable.Action.Result> results = action.invoke();

        if (!results.isEmpty() && results[0].isSuccess()) {
            Map<String, Object> outputParams = results[0].getOutputParameters();
            String agentResponseJson = (String) outputParams.get('agentResponse');
            Map<String, Object> responseMap = (Map<String, Object>) JSON.deserializeUntyped(agentResponseJson);
            agentResponse = (String) responseMap.get('value');
            sessionIdOut = (String) outputParams.get('sessionId');
        } else {
            agentResponse = 'Sorry, Agentforce is not available at the moment. Please try again later.';
        }

        String ttsAudio = '';
        try {
            ttsAudio = getTTSBase64Audio(stripUrlsForTTS(agentResponse), languageCode, voiceGender, 'MP3');
        } catch (Exception e) {
            ttsAudio = e.getMessage();
        }

        return new Map<String, String>{
            'sessionId' => sessionIdOut,
            'agentResponse' => agentResponse,
            'ttsAudio' => ttsAudio
        };
    }
    
    @AuraEnabled(cacheable=false)
    public static String getTTSBase64Audio(String text, String languageCode, String voiceName, String audioEncoding) {
        // Your Google Cloud API key
        String apiKey = 'AIzaSyD8SZI6k5yjIIxkvYPYRrR01bWCKav9pVo';
        
        // Log the TTS request for debugging
        System.debug('TTS Request - Text: ' + text + ', Language: ' + languageCode + ', Voice: ' + voiceName);
        
        HttpRequest req = new HttpRequest();
        req.setEndpoint('https://texttospeech.googleapis.com/v1beta1/text:synthesize?key=' + apiKey);
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/json; charset=utf-8');
        
        Map<String, Object> body = new Map<String, Object>{
            'input' => new Map<String, Object>{'text' => text},
            'voice' => new Map<String, Object>{
                'languageCode' => languageCode,
                'name' => voiceName
            },
            'audioConfig' => new Map<String, Object>{
                'audioEncoding' => audioEncoding,
                'speakingRate' => 1.0,
                'pitch'=> 0
            }
        };
        req.setBody(JSON.serialize(body));
        req.setTimeout(120000);
        
        Http http = new Http();
        HttpResponse res = http.send(req);
        
        if (res.getStatusCode() == 200) {
            Map<String, Object> result = (Map<String, Object>) JSON.deserializeUntyped(res.getBody());
            return (String) result.get('audioContent');
        } else {
            System.debug('TTS Error - Status: ' + res.getStatusCode() + ', Body: ' + res.getBody());
            return 'TTS callout failed: ' + res.getBody();
        }
    }
    
    private static String stripUrlsForTTS(String text) {
        if (String.isBlank(text)) return text;
        String cleaned = text.replaceAll('https?://[^\\s]+', '');
        cleaned = cleaned.replaceAll('\\s{2,}', ' ').trim();
        return cleaned;
    }
    
    private static String formatPhoneNumbers(String text) {
        if (String.isBlank(text)) {
            return text;
        }
        
        String formattedText = text;
        Pattern pattern = Pattern.compile('\\d{10}');
        Matcher matcher = pattern.matcher(text);
        
        while (matcher.find()) {
            String phone = matcher.group();
            String spacedPhone = '';
            
            // Add space between each digit
            for (Integer i = 0; i < phone.length(); i++) {
                spacedPhone += phone.substring(i, i + 1);
                if (i < phone.length() - 1) {
                    spacedPhone += ' ';
                }
            }
            
            formattedText = formattedText.replace(phone, spacedPhone);
        }
        
        return formattedText;
    }
}