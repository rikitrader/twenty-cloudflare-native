import{o as G}from"./chunk-ChpBd9eV.js";import{t as b}from"./jsx-runtime-BmDUFisN.js";import{t as P}from"./react-M6yZRsSc.js";import{u as i}from"./types-B1Nl-NC7-CP3NR7BC.js";import{En as S}from"./utils-Cz7Ljo6y-CFEmid-V.js";import{r as I}from"./dist-C0k9q2wC.js";import{r as m}from"./layout-GaTEE2ty-BAr5SYLm.js";import{t as h}from"./typography-0W7dTJd5-cWdtERIZ.js";import{i as W}from"./feedback-B8qCrrXa-BQNdimoS.js";import{n as $}from"./lib-C3IpGLsk.js";import{t as B}from"./useQuery-klx7Id1G.js";import{t as M}from"./useMutation-Ds2Pb-th.js";import{t as d}from"./SettingsTextInput-CLtEPB9g.js";import{t as q}from"./useApolloCoreClient-cYHBUwoT.js";import{t as H}from"./useNavigateSettings-B0eDCeZz.js";import{t as R}from"./downloadFile-Sco-AQ-M.js";import{cl as U,dl as F,ml as Q,ul as V}from"./index-D6X3OEUa.js";import{i as k,n as z,r as X,t as Y}from"./getDpaPreview-C0wWNu0F.js";var t=b(),r=G(P(),1),Z=$`
  mutation GenerateSignedDpa($input: GenerateSignedDpaInput!) {
    generateSignedDpa(input: $input) {
      downloadUrl
      agreement {
        id
        type
        templateVersion
        region
        processorEntity
        customerLegalEntityName
        signatoryName
        signatoryTitle
        acceptedByEmail
        acceptedAt
        createdAt
      }
    }
  }
`,fe=()=>{const{i18n:e,_:J}=I(),c=H(),{enqueueToast:p}=W(),u=q(),[n,v]=(0,r.useState)(""),[o,E]=(0,r.useState)(""),[s,N]=(0,r.useState)(""),[g,_]=(0,r.useState)(!1),{data:x,loading:D}=B(Y,{client:u}),[j]=M(Z,{client:u,refetchQueries:[{query:z}],awaitRefetchQueries:!0}),a=x?.dpaPreview,f=n.trim()!==""&&o.trim()!==""&&s.trim()!==""&&!a?.notice&&!g,w=async()=>{if(!f)return;_(!0);const y=n.trim(),L=o.trim(),A=s.trim();try{const{data:T}=await j({variables:{input:{customerLegalEntityName:y,signatoryName:L,signatoryTitle:A}}}),l=T?.generateSignedDpa;if(!l)throw new Error("No result returned");const C=y.replace(/[/\\:*?"<>|]+/g,"-");await R(l.downloadUrl,`Twenty-DPA-${l.agreement.templateVersion}-${C}.pdf`),p({variant:"success",children:e._({id:"Z2Wg9g"})}),c(i.LegalDpa)}catch{p({variant:"error",children:e._({id:"NonvA5"})})}finally{_(!1)}};return D?(0,t.jsx)(Q,{}):(0,t.jsx)(F,{title:e._({id:"H3rta9"}),links:[{children:e._({id:"pmUArF"}),href:S(i.General)},{children:e._({id:"vifyyw"}),href:S(i.LegalDpa)},{children:e._({id:"ziAjHi"})}],actionButton:(0,t.jsx)(V,{isSaveDisabled:!f,isLoading:g,onCancel:()=>c(i.LegalDpa),onSave:w}),children:(0,t.jsxs)(U,{children:[a?.notice&&(0,t.jsx)(m,{children:(0,t.jsx)(X,{text:a.notice})}),(0,t.jsxs)(m,{children:[(0,t.jsx)(h,{title:e._({id:"mmGBWT"}),description:e._({id:"Ya1wb4"})}),(0,t.jsx)(d,{instanceId:"dpa-legal-entity-name",label:e._({id:"nc/jNe"}),placeholder:e._({id:"BXMLsb"}),value:n,onChange:v,fullWidth:!0}),(0,t.jsx)(d,{instanceId:"dpa-signatory-name",label:e._({id:"3yzHpm"}),placeholder:e._({id:"A1CyH/"}),value:o,onChange:E,fullWidth:!0}),(0,t.jsx)(d,{instanceId:"dpa-signatory-title",label:e._({id:"a6TaW9"}),placeholder:e._({id:"Gpb1xF"}),value:s,onChange:N,fullWidth:!0})]}),a&&(0,t.jsxs)(m,{children:[(0,t.jsx)(h,{title:e._({id:"rdUucN"}),description:e._({id:"21Xjwu"})}),(0,t.jsx)(k,{document:a})]})]})})};export{fe as SettingsLegalDpaNew};
