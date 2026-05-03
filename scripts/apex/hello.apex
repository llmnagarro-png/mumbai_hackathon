// Use .apex files to store anonymous Apex.
// You can execute anonymous Apex in VS Code by selecting the
//     apex text and running the command:
//     SFDX: Execute Anonymous Apex with Currently Selected Text
// You can also execute the entire file by running the command:
//     SFDX: Execute Anonymous Apex with Editor Contents

Invocable.Action action = Invocable.Action.createCustomAction(
    // 'generateAiAgentResponse', 'Agentforce_Service_Agent'
'generateAiAgentResponse', 'Consumer_Goods_Specialist_Agent'
    );

action.setInvocationParameter('userMessage', 'hi');
List<Invocable.Action.Result> results = action.invoke();
Map<String, Object> outputParams = results[0].getOutputParameters();
String agentResponseJson = (String) outputParams.get('agentResponse');
Map<String, Object> responseMap = (Map<String, Object>) JSON.deserializeUntyped(agentResponseJson);
string agentResponse = (String) responseMap.get('value');
string sessionIdOut = (String) outputParams.get('sessionId');
System.debug('Agent Response: ' + agentResponse);