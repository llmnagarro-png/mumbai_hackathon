@RestResource(urlMapping='/twilio/webhook/*')
global without sharing class TwilioWhatsAppWebhook {

    private static final String TWILIO_ACCOUNT_SID = 'ACd849133bf5e9ae3424aa3238432c2429';//Vaibhav Twilio :-'ACea900a7c53c8fe2929729e6878a60499';
    private static final String TWILIO_AUTH_TOKEN = 'a690f9df4bd3108ef268eed859fe7fa0'; //Vaibhav Twilio :- '6d5e0f6d3d4bf0d743e87dd1d9e94602';
    private static final String TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01/Accounts';
    private static final String ANALYZE_API_URL = 'https://dmart-extraction.vercel.app/analyze';

    @HttpPost
    global static void handleIncomingMessage() {
         String fromNum = null;
        try {
            RestRequest req = RestContext.request;
            Map<String, String> params = req.params;

            fromNum = params.get('From');
            String toNum        = params.get('To');
            String bodyMsg      = params.get('Body');
            String messageSid   = params.get('MessageSid');

            // Show typing indicator on the WhatsApp user's device while we process the request
            sendTypingIndicator(messageSid);

            String fromINRNum = extractPhoneNumber(fromNum);
            String sessionId = getSessionId(fromNum);
            system.debug('fromNum '+fromNum);
            system.debug('fromINRNum '+fromINRNum);
            Integer numMedia = 0;
            if (String.isNotBlank(params.get('NumMedia'))) {
                numMedia = Integer.valueOf(params.get('NumMedia'));
            }

            String finalReply = 'You are not a valid user. Please contact support.';
            
            String currentUserName = [
                SELECT Name
                FROM User
                WHERE Id = :UserInfo.getUserId()
                LIMIT 1
            ].Name;

            if (numMedia > 0) {

                String mediaUrl = params.get('MediaUrl0');
                String contentType = params.get('MediaContentType0');

                String apiResponse = processImageAndStore(mediaUrl, contentType, fromNum);
                System.debug('====API RESPONSE====' + apiResponse); // ADD THIS

                Map<String, String> copilotResponse =
                    interactWithCopilot(
                        'Convert this JSON into readable customer response: ' + apiResponse,
                        sessionId,fromNum
                    );

                finalReply = copilotResponse.get('agentResponse');

            } else {

                Map<String, String> copilotResponse =
                    interactWithCopilot('Customer Phone: ' + fromINRNum + '\n' + bodyMsg, sessionId,fromNum);

                finalReply = copilotResponse.get('agentResponse'); //'Hello from ' + currentUserName + '\n\n' +
                String newSessionId = copilotResponse.get('sessionId');
                
                if (String.isNotBlank(newSessionId)) {
                    saveSessionId(fromNum, newSessionId);
                }
            }

            sendWhatsAppMessage(toNum, fromNum, finalReply);

        } catch (Exception e) {
            System.debug('Error: ' + e.getMessage());
            System.debug('Line: ' + e.getLineNumber());
             saveNotification(fromNum, e.getMessage()+e.getLineNumber());
        }
    }

    @HttpGet
    global static String testing() {
        return 'Twilio Webhook Working';
    }

    // ==========================================
    // Send Typing Indicator via Twilio Indicators API
    // Sends a "typing..." signal on the WhatsApp user's device
    // while the agent is generating a response.
    // Requires the MessageSid of the incoming message.
    // ==========================================
    public static void sendTypingIndicator(String messageSid) {
        if (String.isBlank(messageSid)) {
            System.debug('sendTypingIndicator: MessageSid is blank, skipping.');
            return;
        }
        try {
            String requestBody =
                'messageId=' + EncodingUtil.urlEncode(messageSid, 'UTF-8') +
                '&channel=whatsapp';

            HttpRequest req = new HttpRequest();
            req.setEndpoint('https://messaging.twilio.com/v2/Indicators/Typing.json');
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/x-www-form-urlencoded');
            req.setHeader('Authorization', 'Basic ' + EncodingUtil.base64Encode(
                Blob.valueOf(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN)
            ));
            req.setBody(requestBody);
            req.setTimeout(120000);

            Http http = new Http();
            HttpResponse res = http.send(req);
        } catch (Exception e) {
            // Non-fatal — log and continue so the main flow is not interrupted
             saveNotification('sendTypingIndicator', e.getMessage());
            System.debug('sendTypingIndicator error: ' + e.getMessage());
        }
    }

    // ==========================================
    // Download image -> Convert base64 -> Call API -> Store response
    // ==========================================
    public static String processImageAndStore(String mediaUrl, String contentType, String fromNum) {
    try {
        Http http = new Http();

        // STEP 1: Download image from Twilio (handle 307 redirect)
        HttpRequest imgReq = new HttpRequest();
        imgReq.setEndpoint(mediaUrl);
        imgReq.setMethod('GET');
        imgReq.setTimeout(120000);
        imgReq.setHeader('Authorization', 'Basic ' + EncodingUtil.base64Encode(
            Blob.valueOf(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN)
        ));

        HttpResponse imgRes = http.send(imgReq);
        System.debug('First request status: ' + imgRes.getStatusCode());

        // Handle 307 Temporary Redirect
        if (imgRes.getStatusCode() == 307 || imgRes.getStatusCode() == 301 || imgRes.getStatusCode() == 302) {
            String redirectUrl = imgRes.getHeader('Location');
            System.debug('Redirecting to: ' + redirectUrl);

            // Follow the redirect WITHOUT auth header
            HttpRequest redirectReq = new HttpRequest();
            redirectReq.setEndpoint(redirectUrl);
            redirectReq.setMethod('GET');
            redirectReq.setTimeout(120000);

            imgRes = http.send(redirectReq);
            System.debug('Redirect response status: ' + imgRes.getStatusCode());
        }

        if (imgRes.getStatusCode() != 200) {
            return '{"error":"Unable to download image after redirect. Status: ' + imgRes.getStatusCode() + '"}';
        }

        Blob imageBlob = imgRes.getBodyAsBlob();
        System.debug('Image downloaded successfully. Size: ' + imageBlob.size());

        // STEP 2: Send to Analyze API as multipart/form-data
        String boundary = '----FormBoundary7MA4YWxkTrZu0gW';
        String filename = contentType.contains('png') ? 'upload.png' : 'upload.jpg';

        String header = '--' + boundary + '\r\n' +
            'Content-Disposition: form-data; name="image"; filename="' + filename + '"\r\n' +
            'Content-Type: ' + contentType + '\r\n\r\n';
        String footer = '\r\n--' + boundary + '--';

        Blob bodyBlob = EncodingUtil.convertFromHex(
            EncodingUtil.convertToHex(Blob.valueOf(header)) +
            EncodingUtil.convertToHex(imageBlob) +
            EncodingUtil.convertToHex(Blob.valueOf(footer))
        );

        HttpRequest apiReq = new HttpRequest();
        apiReq.setEndpoint(ANALYZE_API_URL);
        apiReq.setMethod('POST');
        apiReq.setTimeout(120000);
        apiReq.setHeader('Content-Type', 'multipart/form-data; boundary=' + boundary);
        apiReq.setHeader('X-API-Key', 'e13e50646cc067145caf2453fa42b69d297a08e123369927752875aa974acc67');
        apiReq.setBodyAsBlob(bodyBlob);

        System.debug('Calling Analyze API...');
        HttpResponse apiRes = http.send(apiReq);
        System.debug('Analyze API Status: ' + apiRes.getStatusCode());
        System.debug('Analyze API Response: ' + apiRes.getBody());

        if (apiRes.getStatusCode() == 200) {
            return apiRes.getBody();
        } else {
            return '{"error":"Analyze API failed. Status: ' + apiRes.getStatusCode() + ', Body: ' + apiRes.getBody() + '"}';
        }

    } catch (Exception e) {
        System.debug('processImageAndStore EXCEPTION: ' + e.getMessage());
        System.debug('processImageAndStore LINE: ' + e.getLineNumber());
        return '{"error":"' + e.getMessage() + ' at line ' + e.getLineNumber() + '"}';
    }
}
    // ==========================================
    // Send WhatsApp Message
    // ==========================================
   @future(callout=true)
    public static void sendWhatsAppMessage(String fromNumber, String toNumber, String message) {

        String endpoint = TWILIO_API_BASE + '/' + TWILIO_ACCOUNT_SID + '/Messages.json';

        String requestBody =
            'From=' + EncodingUtil.urlEncode(fromNumber, 'UTF-8') +
            '&To=' + EncodingUtil.urlEncode(toNumber, 'UTF-8') +
            '&Body=' + EncodingUtil.urlEncode(message, 'UTF-8');

        HttpRequest req = new HttpRequest();
        req.setEndpoint(endpoint);
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/x-www-form-urlencoded');

        String authHeader = 'Basic ' + EncodingUtil.base64Encode(
            Blob.valueOf(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN)
        );

        req.setHeader('Authorization', authHeader);
        req.setBody(requestBody);

        Http http = new Http();
        HttpResponse res = http.send(req);
        System.debug('Twilio Status: ' + res.getStatusCode());
        System.debug('Twilio Response: ' + res.getBody());
    }

    // ==========================================
    // Agentforce
    // ==========================================
    private static Map<String, String> interactWithCopilot(String userMessage, String sessionId,String fromNum) {

        Invocable.Action action = Invocable.Action.createCustomAction(
            'generateAiAgentResponse',
            'Service_Agent_Script'
        );

        action.setInvocationParameter('userMessage', userMessage);
        action.setInvocationParameter('fromNumber', fromNum);

        if (String.isNotBlank(sessionId)) {
            action.setInvocationParameter('sessionId', sessionId);
        }

        List<Invocable.Action.Result> results = action.invoke();

        if (!results.isEmpty() && results[0].isSuccess()) {

            Map<String, Object> outputParams = results[0].getOutputParameters();
            String agentResponseJson = (String) outputParams.get('agentResponse');

            Map<String, Object> responseMap =
                (Map<String, Object>) JSON.deserializeUntyped(agentResponseJson);

            return new Map<String, String>{
                'sessionId' => (String) outputParams.get('sessionId'),
                'agentResponse' => (String) responseMap.get('value')
            };
        }

        return new Map<String, String>{
            'agentResponse' => 'Sorry, unable to process request.'
        };
    }
    
    private static String getSessionId(String phone) {
    List<WhatsApp_Session__c> records = [
        SELECT SessionId__c
        FROM WhatsApp_Session__c
        WHERE Phone__c = :phone AND
        Active_Session__c = True
        LIMIT 1
    ];

    return records.isEmpty() ? null : records[0].SessionId__c;
}
    
    private static void saveSessionId(String phone, String sessionId) {

    List<WhatsApp_Session__c> records = [
        SELECT Id, SessionId__c,Active_Session__c
        FROM WhatsApp_Session__c
        WHERE Phone__c = :phone AND
        Active_Session__c = True
        LIMIT 1
    ];

    if (records.isEmpty()) {
        insert new WhatsApp_Session__c(
            Phone__c = phone,
            SessionId__c = sessionId
        );
    } else {
        records[0].SessionId__c = sessionId;
        update records[0];
    }
}
    
    public static void saveNotification(String fromNum, String bodyMsg) {
        try {
            List<CustomNotificationType> notifTypes = [
                SELECT Id
                FROM CustomNotificationType
                WHERE DeveloperName = 'WhatsApp_Incoming_Message'
                LIMIT 1
            ];

            if (notifTypes.isEmpty()) {
                System.debug('CustomNotificationType "WhatsApp_Incoming_Message" not found. Skipping notification.');
                return;
            }

            String title = 'New WhatsApp Message Received';
            String body  = 'From: ' + fromNum +
                           (String.isNotBlank(bodyMsg)
                               ? ' - ' + bodyMsg.left(100)
                               : ' - Media message received');

            Messaging.CustomNotification notif = new Messaging.CustomNotification();
            notif.setTitle(title);
            notif.setBody(body);
            notif.setNotificationTypeId(notifTypes[0].Id);
            notif.setTargetId('005bm00000O8qV3AAJ');
            notif.send(new Set<String>{ '005bm00000O8qV3AAJ' });

            System.debug('Notification sent for incoming message from: ' + fromNum);
        } catch (Exception e) {
            System.debug('saveNotification error: ' + e.getMessage());
        }
    }

    private static String extractPhoneNumber(String fromNum) {
    if (String.isBlank(fromNum)) return null;

    // Remove 'whatsapp:' prefix if present
    fromNum = fromNum.replace('whatsapp:', '');

    // Keep only digits
    String digitsOnly = fromNum.replaceAll('[^0-9]', '');

    // If number is longer than 10 digits, take last 10 digits
    if (digitsOnly.length() > 10) {
        return digitsOnly.substring(digitsOnly.length() - 10);
    }

    return digitsOnly;
}
}
/*@RestResource(urlMapping='/twilio/webhook/*')
global without sharing class TwilioWhatsAppWebhook {
    private static final String TWILIO_ACCOUNT_SID = 'ACea900a7c53c8fe2929729e6878a60499';
    private static final String TWILIO_AUTH_TOKEN = '6d5e0f6d3d4bf0d743e87dd1d9e94602';
    private static final String TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01/Accounts';
    private static final String CACHE_PARTITION = 'local.WhatsappChatSession';
    private static final Integer CACHE_TTL = 86400;
    private static Cache.OrgPartition orgPart = Cache.Org.getPartition(CACHE_PARTITION);
    private static String fromNum;

    private static final Set<String> ageProofDocSet = new Set<String>{
        'pan card', 'aadhaar card', 'passport', 'dl', 'voter id'
    };

    private static final Set<String> addressProofDocSet = new Set<String>{
        'valid rental agreement', 'pension payment order', 'utility bills',
        'valid rental agreement with landlord', 'letter of allotment of accomodation',
        'passbook', 'others'
    };

    private static final Set<String> incomeProofDocSet = new Set<String>{
        'bank statement (6 months)', 'payslip', 'itr'
    };

    @HttpPost
    global static void handleIncomingMessage() {
        try {
            RestRequest req = RestContext.request;
            Map<String, String> params = req.params;

            fromNum = params.get('From');
            String toNum = params.get('To');
            String userMessage = params.get('Body');
            Integer numMedia = Integer.valueOf(params.get('NumMedia'));
            List<Map<String, String>> mediaList = new List<Map<String, String>>();

            if (numMedia > 0) {
                for (Integer i = 0; i < numMedia; i++) {
                    String mediaUrl = params.get('MediaUrl' + i);
                    String contentType = params.get('MediaContentType' + i);
                    mediaList.add(new Map<String, String>{
                        'url' => mediaUrl,
                        'type' => contentType
                    });
                }
            }

            String customerProvidedPhone = extractCustomerPhone(userMessage);
            System.debug('customerProvidedPhone ' + customerProvidedPhone);
            Id strLeadId;
            if (customerProvidedPhone != null) {
                List<Lead> getLead = [SELECT Id, Phone FROM Lead WHERE Phone = :customerProvidedPhone ORDER BY CreatedDate DESC LIMIT 1];
                if (!getLead.isEmpty()) {
                    strLeadId = getLead[0].Id;
                }
            }

            for (Integer i = 0; i < numMedia; i++) {
                String mediaUrl = params.get('MediaUrl' + i);
                String contentType = params.get('MediaContentType' + i);
                String fileName = 'WhatsApp_Media_' + DateTime.now().getTime() + '_' + i;
                saveMediaToRecord(mediaUrl, contentType, fileName, strLeadId);
                userMessage = 'done';
            }

            String cacheKey = 'session' + fromNum?.replace('whatsapp:+','');
            Map<String, String> sessionData = (Map<String, String>) orgPart.get(cacheKey);

            String sessionId = (sessionData != null) ? sessionData.get('sessionId') : null;
            Map<String, String> copilotResponse = interactWithCopilot(userMessage, sessionId);

            sessionData = new Map<String, String>{
                'sessionId' => copilotResponse.get('sessionId'),
                'lastResponse' => copilotResponse.get('agentResponse'),
                'lastUsermsg' => userMessage?.toLowerCase()
            };
            orgPart.put(cacheKey, sessionData, CACHE_TTL);
            sendWhatsAppMessage(toNum, fromNum, copilotResponse.get('agentResponse'));
            sendInAppNotification('Message Send', copilotResponse.get('agentResponse'));

        } catch (Exception e) {
            sendInAppNotification('App Error:',  e.getMessage()+e.getLineNumber());
            System.debug('Error message ' + e.getMessage());
            System.debug('Error Line ' + e.getLineNumber());
        }
    }

    @HttpGet
    global static String testing() {
        return 'Site Working';
    }

    public static void sendWhatsAppMessage(String fromNumber, String toNumber, String message) {
        String endpoint = TWILIO_API_BASE + '/' + TWILIO_ACCOUNT_SID + '/Messages.json';

        Map<String, String> params = new Map<String, String>{
            'From' => fromNumber,
            'To' => toNumber,
            'Body' => message
        };

        String requestBody = '';
        for (String key : params.keySet()) {
            if (!String.isEmpty(requestBody)) {
                requestBody += '&';
            }
            requestBody += EncodingUtil.urlEncode(key, 'UTF-8') + '=' +
                          EncodingUtil.urlEncode(params.get(key), 'UTF-8');
        }

        HttpRequest req = new HttpRequest();
        req.setEndpoint(endpoint);
        req.setMethod('POST');
        req.setHeader('Content-Type', 'application/x-www-form-urlencoded');

        String authHeader = 'Basic ' + EncodingUtil.base64Encode(
            Blob.valueOf(TWILIO_ACCOUNT_SID + ':' + TWILIO_AUTH_TOKEN)
        );
        req.setHeader('Authorization', authHeader);
        req.setBody(requestBody);

        Http http = new Http();
        HttpResponse res = http.send(req);

        System.debug('Twilio API Response Status: ' + res.getStatusCode());
        System.debug('Twilio API Response Body: ' + res.getBody());
    }

    private static Map<String, String> interactWithCopilot(String userMessage, String sessionId) {
        Invocable.Action action = Invocable.Action.createCustomAction(
            'generateAiAgentResponse', 'Agentforce_Service_Agent'
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
            String responseValue = (String) responseMap.get('value');

            return new Map<String, String>{
                'sessionId' => (String) outputParams.get('sessionId'),
                'agentResponse' => responseValue
            };
        } else {
            return new Map<String, String>{
                'agentResponse' => 'Sorry, I encountered an error. Please try again.'
            };
        }
    }

    @future(callout=true)
    public static void saveMediaToRecord(String mediaUrl, String contentType, String fileName, Id parentId) {
        Http http = new Http();
        HttpRequest req = new HttpRequest();
        req.setEndpoint(mediaUrl);
        req.setMethod('GET');

        HttpResponse res = http.send(req);
        Integer redirectCount = 0;

        while ((res.getStatusCode() == 301 || res.getStatusCode() == 307) && redirectCount < 5) {
            redirectCount++;
            String redirectUrl = res.getHeader('Location');
            req = new HttpRequest();
            req.setEndpoint(redirectUrl);
            req.setMethod('GET');
            res = http.send(req);
        }

        if (res.getStatusCode() == 200) {
            Blob mediaBlob = res.getBodyAsBlob();

            Attachment attachment = new Attachment();
            attachment.ParentId = parentId;
            attachment.Name = fileName;
            attachment.Body = mediaBlob;
            attachment.ContentType = contentType;
            insert attachment;

            String cacheKey = 'session' + fromNum?.replace('whatsapp:+','');
            Map<String, String> sessionData = (Map<String, String>) orgPart.get(cacheKey);
            String lastUserMsg = (sessionData != null) ? sessionData.get('lastUsermsg') : null;

            /*if (lastUserMsg != null && lastUserMsg.contains('aadhaar card')) {
                ValidateDocumentController.validateDocument(
                    EncodingUtil.base64Encode(mediaBlob), parentId, 'Aadhaar Card', attachment.Id
                );
            }*/
            /*System.debug('Media attached to record successfully.');
        } else {
            System.debug('Final response not 200. Status: ' + res.getStatusCode());
        }
    }

    private static String extractCustomerPhone(String message) {
        Pattern phonePattern = Pattern.compile('\\b(?:\\+91[-\\s]?)?(\\d{10})\\b');
        Matcher m = phonePattern.matcher(message);
        if (m.find()) {
            return m.group(0);
        }
        return null;
    }

    private static void sendInAppNotification(String title, String message) {

		CustomNotificationType cnType = [SELECT Id FROM CustomNotificationType WHERE DeveloperName = 'Whatsapp_Message_Notification' WITH SYSTEM_MODE];

        Messaging.CustomNotification notification = new Messaging.CustomNotification();
        notification.setTitle(title);
        notification.setBody(message);
		notification.setNotificationTypeId(cnType.id);
		notification.setTargetId('006Hu00001f7CQ2IAM');
        notification.send(new Set<String>{ '005Hu00000RuOrPIAV' });
    }
}*/