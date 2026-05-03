public without sharing class GetVisitPlan {

    @InvocableMethod
    public static List<ResponseWrapper> visitPlan(List<RequestWrapper> reqList) {

        List<ResponseWrapper> responseList = new List<ResponseWrapper>();

        if (reqList == null || reqList.isEmpty()) {
            return responseList;
        }

        Set<String> phoneNumbers = new Set<String>();
        for (RequestWrapper req : reqList) {
            if (req.ContactNumber != null) {
                phoneNumbers.add(req.ContactNumber);
            }
        }

        if (phoneNumbers.isEmpty()) {
            return responseList;
        }

        User currentUser = [Select Id, Email From User Where Id = '005bm00000O8qV3AAJ'];
        // Fetch Contacts
        Map<String, Id> phoneToContactMap = new Map<String, Id>();
        for (Contact con : [
            SELECT Id, Phone 
            FROM Contact 
            WHERE Email = :currentUser.Email
        ]) {
            phoneToContactMap.put(con.Phone, con.Id);
        }

        if (phoneToContactMap.isEmpty()) {
            return responseList;
        }

        List<Visit> visits = [
            SELECT Id, Status, VisitPriority, VisitorId,Account_Name__c,Location__c,Store_Name__c
            FROM Visit 
            WHERE VisitorId IN :phoneToContactMap.values()
        ];

        ResponseWrapper resWrapper = new ResponseWrapper();
        resWrapper.visits = new List<VisitData>();
        
        for (Visit vs : visits) {
            VisitData v = new VisitData();
            v.status = vs.Status;
            v.priority = vs.VisitPriority;
            v.Name = vs.Account_Name__c;
            v.Location = vs.Location__c;
            v.StoreName = vs.Store_Name__c;
            resWrapper.visits.add(v);
        }
        
        responseList.add(resWrapper);
        return responseList;
    }
    
    public class VisitData {
        @InvocableVariable public String status;
        @InvocableVariable public String priority;
        @InvocableVariable public String Location;
        @InvocableVariable public String Name;
        @InvocableVariable public String StoreName;
    }
    
    public class ResponseWrapper {
        @InvocableVariable
        public List<VisitData> visits;
    }

    public class RequestWrapper {
        @InvocableVariable
        public String ContactNumber;
    }
}