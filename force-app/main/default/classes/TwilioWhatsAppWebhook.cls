@RestResource(urlMapping='/twilio/webhook/*')
global without sharing class TwilioWhatsAppWebhook {

    private static final String TWILIO_ACCOUNT_SID = 'ACd849133bf5e9ae3424aa3238432c2429';
    private static final String TWILIO_AUTH_TOKEN = 'a690f9df4bd3108ef268eed859fe7fa0';
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
                System.debug('====API RESPONSE====' + apiResponse);

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

    fromNum = fromNum.replace('whatsapp:', '');

    String digitsOnly = fromNum.replaceAll('[^0-9]', '');

    if (digitsOnly.length() > 10) {
        return digitsOnly.substring(digitsOnly.length() - 10);
    }

    return digitsOnly;
}
}