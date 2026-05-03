public with sharing class CreateCustomOrder {

    public class Request {
        @InvocableVariable(required=true)
        public String accountName;

        @InvocableVariable(required=true)
        public List<ProductRequest> products;
    }

    public class ProductRequest {
        @InvocableVariable(required=true)
        public String productName;

        @InvocableVariable(required=true)
        public Integer quantity;
    }

    public class Response {
        @InvocableVariable
        public String message;

        @InvocableVariable
        public String orderNumber;
    }

    @InvocableMethod(label='Create Order')
    public static List<Response> createOrder(List<Request> requests) {

        List<Response> responses = new List<Response>();

        for (Request req : requests) {

            Response res = new Response();

            try {

                // 1. Fetch Account using Account Name
                List<Account> accList = [
                    SELECT Id, Name 
                    FROM Account 
                    WHERE Name = :req.accountName
                    LIMIT 2
                ];

                if (accList.isEmpty()) {
                    res.message = 'No account found with the provided name. Please verify and try again.';
                    responses.add(res);
                    continue;
                }

                if (accList.size() > 1) {
                    res.message = 'Multiple accounts found with this name. Please provide a more specific name.';
                    responses.add(res);
                    continue;
                }

                Account acc = accList[0];

                // 2. Get Standard Pricebook
                Pricebook2 standardPricebook = [
                    SELECT Id 
                    FROM Pricebook2 
                    WHERE IsStandard = true 
                    LIMIT 1
                ];

                // 3. Create Order record (Standard Object)
                Order ord = new Order(
                    AccountId = acc.Id,
                    Status = 'Draft',
                    EffectiveDate = Date.today(),
                    Pricebook2Id = standardPricebook.Id
                );

                insert ord;

                // 4. Fetch Products by Name
                Set<String> productNames = new Set<String>();
                for (ProductRequest p : req.products) {
                    if (p.productName != null) {
                        productNames.add(p.productName);
                    }
                }

                Map<String, Product2> productMap = new Map<String, Product2>();
                for (Product2 prod : [
                    SELECT Id, Name 
                    FROM Product2 
                    WHERE Name IN :productNames
                ]) {
                    productMap.put(prod.Name, prod);
                }

                // 5. Get Pricebook Entries for the products
                Map<Id, PricebookEntry> pricebookEntryMap = new Map<Id, PricebookEntry>();
                for (PricebookEntry pbe : [
                    SELECT Id, Product2Id, UnitPrice 
                    FROM PricebookEntry 
                    WHERE Product2Id IN :productMap.values() 
                    AND Pricebook2Id = :standardPricebook.Id
                    AND IsActive = true
                ]) {
                    pricebookEntryMap.put(pbe.Product2Id, pbe);
                }

                // 6. Create Order Items (Standard OrderItem object)
                List<OrderItem> orderItems = new List<OrderItem>();

                for (ProductRequest p : req.products) {

                    if (p.quantity != null && p.quantity > 0 && p.productName != null) {

                        Product2 product = productMap.get(p.productName);
                        
                        if (product == null) {
                            res.message = 'Product not found: ' + p.productName + '. Please verify product names.';
                            responses.add(res);
                            continue;
                        }

                        PricebookEntry pbe = pricebookEntryMap.get(product.Id);
                        
                        if (pbe == null) {
                            res.message = 'Pricebook entry not found for product: ' + p.productName;
                            responses.add(res);
                            continue;
                        }

                        orderItems.add(new OrderItem(
                            OrderId = ord.Id,
                            Product2Id = product.Id,
                            PricebookEntryId = pbe.Id,
                            Quantity = p.quantity,
                            UnitPrice = pbe.UnitPrice
                        ));
                    }
                }

                if (!orderItems.isEmpty()) {
                    insert orderItems;
                }

                // 7. Delivery Date
                Date deliveryDate = Date.today().addDays(2);
                List<Order> createdOrders = [SELECT Id, OrderNumber FROM Order WHERE Id = :ord.Id];
                // 8. Response
                res.orderNumber = createdOrders[0].OrderNumber;
                res.message = 'Your order ' + createdOrders[0].OrderNumber + 
                              ' has been placed successfully and will be delivered by ' + 
                              String.valueOf(deliveryDate);

            } catch (Exception e) {

                res.message = 'Order creation failed: ' + e.getMessage();
            }

            responses.add(res);
        }

        return responses;
    }
}