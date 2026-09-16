import{o as u}from"./chunk-ChpBd9eV.js";import{t as m}from"./react-M6yZRsSc.js";import{t as d}from"./build-CngeiE9P.js";import{t as l}from"./useRedirect-DMLV2ydH.js";import{In as f,s as A}from"./graphql-CBCbBFnA.js";import{t as C}from"./lib-C3IpGLsk.js";import{t as c}from"./useQuery-klx7Id1G.js";import{t as g}from"./useMutation-Ds2Pb-th.js";import{t as v}from"./config-B1E7I59J.js";var P=C`
  query ApplicationConnectionProviders($applicationId: UUID!) {
    applicationConnectionProviders(applicationId: $applicationId) {
      id
      applicationId
      type
      name
      displayName
      logoUrl
      oauth {
        scopes
        isClientCredentialsConfigured
      }
    }
  }
`,b=t=>{const{data:e,loading:n,refetch:o}=c(P,{skip:!t,variables:{applicationId:t??""},fetchPolicy:"cache-first"});return{connectionProviders:e?.applicationConnectionProviders??[],loading:n,refetch:o}},_=d(),D=t=>{const{data:e,loading:n,refetch:o}=c(A,{variables:{applicationId:t},skip:!(0,_.isNonEmptyString)(t),fetchPolicy:"cache-and-network"});return{accounts:e?.applicationConnectedAccounts??[],loading:n,refetch:o}},h=u(m(),1),U=()=>{const[t]=g(f),{redirect:e}=l();return{triggerAppOAuth:(0,h.useCallback)(async({applicationId:n,providerName:o,visibility:p,reconnectingConnectedAccountId:a,redirectLocation:i})=>{const s=(await t()).data?.generateTransientToken.transientToken.token;if(!s)return;const r=new URLSearchParams({applicationId:n,providerName:o,transientToken:s,visibility:p});a&&r.set("reconnectingConnectedAccountId",a),i&&r.set("redirectLocation",i),e(`${v}/auth/apps/authorize?${r.toString()}`)},[t,e])}};export{D as n,b as r,U as t};
