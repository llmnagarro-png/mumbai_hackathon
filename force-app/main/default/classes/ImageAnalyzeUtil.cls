public without sharing class ImageAnalyzeUtil {
    
    private static final String ANALYZE_API_URL = 'https://dmart-extraction.vercel.app/analyze';
    private static final String API_KEY = 'e13e50646cc067145caf2453fa42b69d297a08e123369927752875aa974acc67';
    
    // ✅ Takes raw Blob — works for both Twilio and LWC
    public static String analyzeImage(Blob imageBlob, String contentType) {
        try {
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

            System.debug('analyzeImage - blob size: ' + imageBlob.size());
            System.debug('analyzeImage - body size: ' + bodyBlob.size());

            HttpRequest apiReq = new HttpRequest();
            apiReq.setEndpoint(ANALYZE_API_URL);
            apiReq.setMethod('POST');
            apiReq.setTimeout(120000);
            apiReq.setHeader('Content-Type', 'multipart/form-data; boundary=' + boundary);
            apiReq.setHeader('X-API-Key', API_KEY);
            apiReq.setBodyAsBlob(bodyBlob);

            Http http = new Http();
            HttpResponse apiRes = http.send(apiReq);

            System.debug('analyzeImage - Status: ' + apiRes.getStatusCode());
            System.debug('analyzeImage - Response: ' + apiRes.getBody());

            if (apiRes.getStatusCode() == 200) {
                return apiRes.getBody();
            }
            return '{"error":"Status: ' + apiRes.getStatusCode() + ', Body: ' + apiRes.getBody() + '"}';

        } catch (Exception e) {
            System.debug('analyzeImage error: ' + e.getMessage());
            return '{"error":"' + e.getMessage() + '"}';
        }
    }
}