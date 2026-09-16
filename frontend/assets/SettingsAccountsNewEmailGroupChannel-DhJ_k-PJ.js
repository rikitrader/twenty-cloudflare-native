import{o as S}from"./chunk-ChpBd9eV.js";import{t as v}from"./jsx-runtime-BmDUFisN.js";import{t as y}from"./react-M6yZRsSc.js";import{u as s}from"./types-B1Nl-NC7-CP3NR7BC.js";import{Lt as G}from"./schemas-pe6acdm4.js";import{En as h}from"./utils-Cz7Ljo6y-CFEmid-V.js";import{l as x,o as A}from"./PageCardLayout-C5zjLcP8.js";import{r as N}from"./dist-C0k9q2wC.js";import{r as C}from"./layout-GaTEE2ty-BAr5SYLm.js";import{t as b}from"./getToastOptionsFromError-Njp3fF-h.js";import{t as E}from"./typography-0W7dTJd5-cWdtERIZ.js";import{i as j}from"./feedback-B8qCrrXa-BQNdimoS.js";import{t as I}from"./lib-C3IpGLsk.js";import{t as L}from"./useMutation-Ds2Pb-th.js";import{t as f}from"./SettingsTextInput-CLtEPB9g.js";import{t as M}from"./useNavigateSettings-B0eDCeZz.js";import{cl as T,dl as D,ul as q}from"./index-D6X3OEUa.js";import{t as P}from"./getAllEmailingDomains-C5juEkn8.js";var a=v(),u=S(y(),1),O=I`
  mutation CreateEmailGroupChannel($input: CreateEmailGroupChannelInput!) {
    createEmailGroupChannel(input: $input) {
      messageChannel {
        id
        handle
        visibility
        type
        isSyncEnabled
        excludeGroupEmails
        contactAutoCreationPolicy
      }
      forwardingAddress
    }
  }
`,k=()=>{const{enqueueToast:e}=j(),[c,{loading:i,error:o}]=L(O,{refetchQueries:[{query:x},{query:A},{query:P}]});return{createEmailGroupChannel:(r,l)=>c({variables:{input:{handle:r,displayName:l}},onError:n=>{e(b({error:n}))}}),loading:i,error:o}},te=()=>{const{i18n:e,_:c}=N(),i=M(),{createEmailGroupChannel:o,loading:t}=k(),[r,l]=(0,u.useState)(""),[n,g]=(0,u.useState)(""),m=G().safeParse(r).success&&!t,p=(0,u.useCallback)(async()=>{const d=n.trim(),_=(await o(r,d.length>0?d:void 0)).data?.createEmailGroupChannel.messageChannel.id;_&&i(s.EmailGroupChannelDetail,{messageChannelId:_})},[o,n,r,i]);return(0,a.jsx)(D,{title:e._({id:"papEbS"}),links:[{children:e._({id:"pmUArF"}),href:h(s.General)},{children:e._({id:"hZotg6"}),href:h(s.WorkspaceCommunications)},{children:e._({id:"papEbS"})}],actionButton:(0,a.jsx)(q,{isSaveDisabled:!m,isCancelDisabled:t,isLoading:t,onCancel:()=>i(s.WorkspaceCommunications),onSave:p}),children:(0,a.jsxs)(T,{children:[(0,a.jsxs)(C,{children:[(0,a.jsx)(E,{title:e._({id:"hzKQCy"}),description:e._({id:"Z4WP0F"})}),(0,a.jsx)(f,{instanceId:"email-group-source",label:e._({id:"5f1fxa"}),placeholder:"support@mycompany.com",value:r,onChange:l,onInputEnter:()=>{m&&p()},disabled:t})]}),(0,a.jsxs)(C,{children:[(0,a.jsx)(E,{title:e._({id:"0gS7M5"}),description:e._({id:"+/y8+6"})}),(0,a.jsx)(f,{instanceId:"email-group-display-name",label:e._({id:"0gS7M5"}),placeholder:e._({id:"yYneQW"}),value:n,maxLength:255,onChange:g,onInputEnter:()=>{m&&p()},disabled:t})]})]})})};export{te as SettingsAccountsNewEmailGroupChannel};
