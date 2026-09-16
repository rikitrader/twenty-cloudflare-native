import{o as we}from"./chunk-ChpBd9eV.js";import{t as Fe}from"./jsx-runtime-BmDUFisN.js";import{t as Ge}from"./react-M6yZRsSc.js";import{U as Ue}from"./utilities-DC1jEeOr-CjLldCnA.js";import{J as Me,u as re}from"./types-B1Nl-NC7-CP3NR7BC.js";import{t as R}from"./dist-x6yBUqMs.js";import{t as Be}from"./build-CngeiE9P.js";import{s as Q}from"./theme-constants-CTjFR_ac-BSZx2FmI.js";import{t as c}from"./isDefined-Dtu5EYqP-_d6Dqdoe.js";import{En as ae}from"./utils-Cz7Ljo6y-CFEmid-V.js";import{t as K}from"./useAtomStateValue-Dh9Tkqi-.js";import{t as o}from"./dist-Cg5OofxW.js";import{t as ie}from"./IconCalendarRepeat-Blp2taHS.js";import{t as We}from"./IconChartBar-B6Jn00D8.js";import{t as Y}from"./IconCoins-B0r0Kos5.js";import{t as $e}from"./IconDotsVertical-B8pBwOxf.js";import{t as qe}from"./IconExternalLink-ulJUGaAH.js";import{t as Ke}from"./IconEyeShare-CSqIRONr.js";import{t as He}from"./IconFlag-D1FPjsFn.js";import{t as Ve}from"./IconSettings2-K0Y6HyU2.js";import{t as ze}from"./IconTrash-h0izILIX.js";import{r as ce}from"./dist-C0k9q2wC.js";import{t as Qe}from"./useAtomState-t25i5gHy.js";import{C as Ie,S as W}from"./data-display-gKsNeQfV-DA6XVR-8.js";import{a as Ye,i as J,n as Je}from"./OverflowingTextWithTooltip-DPuVU_BH-DfeYl9fg.js";import{B as Xe,j as Ze,n as le,x as et}from"./input-BtFIK2kq-CYLkBJQm.js";import{y as tt}from"./navigation-DmAyQWOY-CSzgEVVE.js";import{a as rt,r as w,u as at}from"./layout-GaTEE2ty-BAr5SYLm.js";import{t as Te}from"./getToastOptionsFromError-Njp3fF-h.js";import{a as it,o as st,t as M}from"./typography-0W7dTJd5-cWdtERIZ.js";import{i as pe}from"./feedback-B8qCrrXa-BQNdimoS.js";import{t as nt}from"./useAtomComponentStateValue-DfzGI7I2.js";import{x as de,y as V}from"./graphql-CBCbBFnA.js";import{t as $}from"./lib-C3IpGLsk.js";import{t as X}from"./useQuery-klx7Id1G.js";import{t as ue}from"./useMutation-Ds2Pb-th.js";import{t as ot}from"./currentUserState-BjMkh9wE.js";import{t as lt}from"./billingState-BMmCOWgz.js";import{t as dt}from"./ModalStatefulWrapper-Dh8fBO39.js";import{t as me}from"./useModal-Dek0QQjx.js";import{t as Ae}from"./SettingsTextInput-CLtEPB9g.js";import{t as ct}from"./ConfirmationModal-CRS3sGLx.js";import{t as je}from"./currentWorkspaceState-DahEPtKG.js";import{t as ke}from"./useNumberFormat-DSV2MWX4.js";import{t as pt}from"./activeTabIdComponentState-9eGoc4EF.js";import{t as ut}from"./useCloseDropdown-t-lTEZCO.js";import{t as mt}from"./Dropdown-CRJSi42h.js";import{t as fe}from"./getAbsoluteImageUrl-CugI_csu.js";import{t as Se}from"./Table-B46Zylx7.js";import{t as O}from"./TableCell-DSca9vGY.js";import{t as U}from"./TableHeader-BNrAkiaI.js";import{t as H}from"./TableRow-C8DgeYyl.js";import{n as _t,t as It}from"./DropdownMenuItemsContainer-DyyPfdpm.js";import{n as B}from"./date-utils-ClRRmw0o.js";import{t as ge}from"./Select-W0_qxVy5.js";import{B as v,Ff as Re,Gm as se,Nd as At,P as T,Vm as De,Xp as ft,Zf as St,cl as gt,dl as Ct,dt as Ce,ft as I,hm as vt,if as Et,ih as ht,ml as xt,np as bt,nt as yt,th as Tt,vf as jt,vt as kt}from"./index-D6X3OEUa.js";import{t as Z}from"./useApolloAdminClient-mk--ixl3.js";import{t as ne}from"./SettingsTableCard-DAi0VK-S.js";import{t as Rt}from"./TableBody-DIvn_7WK.js";import{t as Ne}from"./SettingsSectionSkeletonLoader-hdkOhnEw.js";import{t as Dt}from"./SettingsTabBar-DvZRdZmp.js";import{t as Nt}from"./AiAdminPath-CNhUEtqy.js";import{n as Lt,t as Ot}from"./useHandleImpersonate-COy7E862.js";import{t as Le}from"./SettingsTableListSection-BRmj9BFi.js";var e=Fe(),Pt=[{value:null,label:{id:"qqeAJM"}},{value:30,label:{id:"I6lVwB"}},{value:60,label:{id:"yPZL9v"}},{value:90,label:{id:"E5fxqI"}},{value:180,label:{id:"WlItll"}},{value:365,label:{id:"5uLUiv"}}],Oe={[T.COMPENSATION]:{id:"amPBVF"},[T.SALES]:{id:"mUv9U4"},[T.ONBOARDING_REWARD]:{id:"wxvgdv"},[T.ROLLOVER]:{id:"Q6o/eX"}},wt=[T.COMPENSATION,T.SALES],Ft=$`
  mutation GrantWorkspaceCredits(
    $workspaceId: UUID!
    $amount: Float!
    $type: BillingCreditGrantType!
    $reason: String
    $expiresInDays: Int
    $clientOperationId: UUID!
  ) {
    grantWorkspaceCredits(
      workspaceId: $workspaceId
      amount: $amount
      type: $type
      reason: $reason
      expiresInDays: $expiresInDays
      clientOperationId: $clientOperationId
    ) {
      id
      amount
      type
      effectiveAt
      expiresAt
      revokedAt
      sourceGrantId
      reason
      isActive
      createdAt
    }
  }
`,_e=$`
  query WorkspaceBillingAdminPanel($workspaceId: UUID!) {
    workspaceBillingAdminPanel(workspaceId: $workspaceId) {
      stripeCustomerId
      creditBalance
      creditGrants {
        id
        amount
        type
        effectiveAt
        expiresAt
        revokedAt
        sourceGrantId
        reason
        isActive
        createdAt
      }
      usage {
        periodStart
        periodEnd
        usedCredits
        grantedCredits
        rolloverCredits
        totalGrantedCredits
        remainingCredits
      }
      subscription {
        stripeSubscriptionId
        status
        interval
        currency
        planKey
        currentPeriodStart
        currentPeriodEnd
        trialStart
        trialEnd
        cancelAt
        canceledAt
        cancelAtPeriodEnd
        items {
          productName
          productKey
          stripePriceId
          quantity
          unitAmount
          includedCredits
        }
      }
    }
  }
`,P=we(Ge(),1),Gt=R("div")({name:"StyledCenteredTitle",class:"s1mndy8p",propsAsIs:!1}),Ut=R("div")({name:"StyledSectionContainer",class:"skq093g",propsAsIs:!1}),Mt=R("div")({name:"StyledFields",class:"s1wy8nlj",propsAsIs:!1}),Bt=R("div")({name:"StyledModalActions",class:"si2xe4k",propsAsIs:!1}),Wt=({modalInstanceId:t,workspaceId:r})=>{const{i18n:s,_:i}=ce(),{closeModal:j}=me(),{enqueueToast:E}=pe(),g=Z(),[l,m]=(0,P.useState)(""),[A,u]=(0,P.useState)(T.COMPENSATION),[n,_]=(0,P.useState)(""),[h,D]=(0,P.useState)(null),[k,p]=(0,P.useState)(null),[x,{loading:d}]=ue(Ft,{client:g,refetchQueries:[_e]}),C=Number(l),F=Number.isFinite(C)&&C>0,N=()=>{m(""),u(T.COMPENSATION),_(""),D(null),p(null),j(t)},f=async()=>{if(!F)return;const b=n.trim(),G=JSON.stringify([C,A,b,h]),z=k?.payload===G?k.clientOperationId:Me();p({payload:G,clientOperationId:z});try{await x({variables:{workspaceId:r,amount:C,type:A,reason:b||null,expiresInDays:h,clientOperationId:z}}),E({variant:"success",children:s._({id:"Tbxf45",values:{parsedAmount:C}})}),N()}catch(ee){E(Te({error:ee}))}};return(0,e.jsxs)(dt,{modalInstanceId:t,onClose:N,isClosable:!0,size:"medium",padding:"large",overlay:"dark",width:"360px",dataGloballyPreventClickOutside:!0,renderInDocumentBody:!0,smallBorderRadius:!0,autoHeight:!0,children:[(0,e.jsx)(Gt,{children:(0,e.jsx)(st,{title:s._({id:"5O8DG6"}),fontColor:it.Primary})}),(0,e.jsx)(Ut,{children:(0,e.jsx)(w,{alignment:rt.Center,fontColor:at.Primary,children:s._({id:"x4qjZw"})})}),(0,e.jsxs)(Mt,{children:[(0,e.jsx)(Ae,{instanceId:`${t}-amount`,label:s._({id:"hehnjM"}),placeholder:"200",type:"number",min:0,leftAdornment:"$",value:l,onChange:m,autoFocusOnMount:!0,fullWidth:!0}),(0,e.jsx)(ge,{dropdownId:`${t}-type`,label:s._({id:"+zy2Nq"}),value:A,options:wt.map(b=>({value:b,label:s._(Oe[b])})),onChange:u,isDropdownInModal:!0,fullWidth:!0}),(0,e.jsx)(ge,{dropdownId:`${t}-expires-in-days`,label:s._({id:"KnN1Tu"}),value:h,options:Pt.map(b=>({value:b.value,label:s._(b.label)})),onChange:D,isDropdownInModal:!0,fullWidth:!0}),(0,e.jsx)(Ae,{instanceId:`${t}-reason`,label:s._({id:"VJScHU"}),placeholder:s._({id:"+g90tY"}),value:n,onChange:_,maxLength:500,fullWidth:!0})]}),(0,e.jsxs)(Bt,{children:[(0,e.jsx)(le,{onClick:N,variant:"secondary",title:s._({id:"dEgA5A"}),fullWidth:!0,justify:"center"}),(0,e.jsx)(le,{onClick:f,variant:"primary",accent:"blue",title:s._({id:"nE5VAt"}),disabled:!F||d,fullWidth:!0,justify:"center"})]})]})},$t=({creditGrantId:t,onRevoke:r})=>{const s=`settings-admin-credit-grant-row-${t}`,{closeDropdown:i}=ut();return(0,e.jsx)(mt,{dropdownId:s,dropdownPlacement:"right-start",clickableComponent:(0,e.jsx)(Ze,{Icon:$e,accent:"tertiary"}),dropdownComponents:(0,e.jsx)(_t,{children:(0,e.jsx)(It,{children:(0,e.jsx)(tt,{accent:"danger",LeftIcon:ze,text:o._({id:"GXsAby"}),onClick:()=>{r(),i(s)}})})})})},qt={[T.COMPENSATION]:"orange",[T.SALES]:"purple",[T.ONBOARDING_REWARD]:"blue",[T.ROLLOVER]:"green"},Kt=$`
  mutation RevokeWorkspaceCreditGrant(
    $workspaceId: UUID!
    $creditGrantId: UUID!
  ) {
    revokeWorkspaceCreditGrant(
      workspaceId: $workspaceId
      creditGrantId: $creditGrantId
    ) {
      id
      amount
      type
      effectiveAt
      expiresAt
      revokedAt
      sourceGrantId
      reason
      isActive
      createdAt
    }
  }
`,Ht=t=>{const r=new Map(t.map(l=>[l.id,l])),s=new Map;for(const l of t){const m=l.sourceGrantId;c(m)&&r.has(m)&&s.set(m,l)}const i=new Set,j=l=>{const m=new Set([l.id]);let A=l,u=s.get(l.id);for(;c(u)&&!m.has(u.id);)m.add(u.id),A=u,u=s.get(u.id);for(const n of m)i.add(n);return{id:l.id,current:A,origin:l}},E=t.filter(l=>!c(l.sourceGrantId)||!r.has(l.sourceGrantId)).map(j);if(i.size===t.length)return E;const g=t.filter(l=>!i.has(l.id)).map(l=>({id:l.id,current:l,origin:l}));return[...E,...g]},Vt="88px 140px 88px 108px 108px 1fr 36px",ve="revoke-credit-grant-modal",zt="—",Qt=t=>c(t.revokedAt)?{label:{id:"xGiT1z"},color:"red"}:t.isActive?{label:{id:"F6pfE9"},color:"green"}:{label:{id:"M1RnFv"},color:"gray"},Yt=({workspaceId:t,creditGrants:r,onGrantCreditsClick:s})=>{const{i18n:i,_:j}=ce(),{formatNumber:E}=ke(),{enqueueToast:g}=pe(),l=Z(),{openModal:m}=me(),[A,u]=(0,P.useState)(null),n=Ht(r),[_,h]=(0,P.useState)(!1),[D]=ue(Kt,{client:l,refetchQueries:[_e]}),k=d=>E(d,{decimals:2}),p=d=>{u(d),m(ve)},x=async d=>{h(!0);try{await D({variables:{workspaceId:t,creditGrantId:d}}),g({variant:"success",children:i._({id:"zH6NZT"})})}catch(C){g(Te({error:C}))}finally{h(!1),u(null)}};return(0,e.jsxs)(e.Fragment,{children:[(0,e.jsx)(Le,{title:i._({id:"fqtGOd"}),description:i._({id:"nbyiz/"}),items:n,columns:[{label:i._({id:"hehnjM"}),Cell:({item:d})=>(0,e.jsx)(e.Fragment,{children:k(d.current.amount)})},{label:i._({id:"+zy2Nq"}),Cell:({item:d})=>(0,e.jsx)(W,{color:qt[d.current.type],children:i._(Oe[d.current.type])})},{label:i._({id:"uAQUqI"}),Cell:({item:d})=>{const C=Qt(d.current);return(0,e.jsx)(W,{color:C.color,children:i._(C.label)})}},{label:i._({id:"E0rSFg"}),Cell:({item:d})=>(0,e.jsx)(e.Fragment,{children:B(d.origin.createdAt)})},{label:i._({id:"KnN1Tu"}),Cell:({item:d})=>(0,e.jsx)(e.Fragment,{children:c(d.current.expiresAt)?B(d.current.expiresAt):i._({id:"qqeAJM"})})},{label:i._({id:"VJScHU"}),overflow:"hidden",Cell:({item:d})=>(0,e.jsx)(J,{text:d.origin.reason??zt})},{label:"",align:"right",Cell:({item:d})=>d.current.isActive?(0,e.jsx)($t,{creditGrantId:d.current.id,onRevoke:()=>p(d.current)}):null}],gridAutoColumns:Vt,footerButtonLabel:i._({id:"5O8DG6"}),onFooterButtonClick:s}),(0,e.jsx)(ct,{modalInstanceId:ve,title:i._({id:"CCR+qC"}),subtitle:c(A)?i._({id:"ddMLFL",values:{0:k(A.amount)}}):"",confirmButtonText:i._({id:"GXsAby"}),loading:_,onConfirmClick:()=>{c(A)&&x(A.id)},onClose:()=>u(null)})]})},Jt="—",Xt=t=>{const r=t.toUpperCase();try{return new Intl.NumberFormat("en-US",{style:"currency",currency:r}).formatToParts(0).find(s=>s.type==="currency")?.value??r}catch{return r}},Zt=({item:t,currency:r,formatNumber:s})=>{const i=[];return c(t.quantity)&&i.push(t.productKey===de.BASE_PRODUCT?`${s(t.quantity)} ${o._({id:"AkeiJW",values:{0:t.quantity}})}`:s(t.quantity)),c(t.includedCredits)&&i.push(`${s(t.includedCredits,{abbreviate:!0,decimals:2})} ${o._({id:"xEqptn",values:{0:t.includedCredits}})}`),c(t.unitAmount)&&i.push(`${Xt(r)}${s(t.unitAmount/100,{decimals:2})}`),i.length>0?i.join(" · "):Jt},er=R("div")({name:"StyledTagsWrapper",class:"sx9h5mh",propsAsIs:!1}),tr=({plan:t,isTrialPeriod:r=!1})=>{const s=t===V.PRO?{color:"sky",label:o._({id:"3fPjUY"})}:{color:"purple",label:o._({id:"ucgZ0o"})};return(0,e.jsxs)(er,{children:[(0,e.jsx)(W,{color:s.color,children:s.label}),r&&(0,e.jsx)(W,{color:"blue",preventShrink:!0,children:o._({id:"lhkaAC"})})]})},rr="https://dashboard.stripe.com",Ee="—",he="settings-admin-grant-workspace-credits",oe=R("div")({name:"StyledContainer",class:"s1hgnhrg",propsAsIs:!1}),ar=R("a")({name:"StyledExternalLink",class:"s19t4op2",propsAsIs:!1}),ir=R("span")({name:"StyledMono",class:"spfurqs",propsAsIs:!1}),sr=R("div")({name:"StyledItemValue",class:"spsfm74",propsAsIs:!1}),nr={[I.Active]:"green",[I.Trialing]:"blue",[I.PastDue]:"orange",[I.Canceled]:"red",[I.Unpaid]:"red",[I.Paused]:"gray",[I.Incomplete]:"gray",[I.IncompleteExpired]:"gray"},or={[I.Active]:"Active",[I.Trialing]:"Trialing",[I.PastDue]:"Past Due",[I.Canceled]:"Canceled",[I.Unpaid]:"Unpaid",[I.Paused]:"Paused",[I.Incomplete]:"Incomplete",[I.IncompleteExpired]:"Incomplete Expired"},lr=t=>t===V.PRO?V.PRO:t===V.ENTERPRISE?V.ENTERPRISE:null,xe=({path:t,id:r})=>(0,e.jsxs)(ar,{href:`${rr}/${t}/${r}`,target:"_blank",rel:"noopener noreferrer",children:[(0,e.jsx)(ir,{children:r}),(0,e.jsx)(qe,{size:12})]}),dr=({workspaceId:t})=>{const{i18n:r,_:s}=ce(),{formatNumber:i}=ke(),{openModal:j}=me(),{data:E,loading:g}=X(_e,{client:Z(),variables:{workspaceId:t},skip:!t});if(g)return(0,e.jsx)(oe,{children:(0,e.jsx)(Ne,{rowCount:6})});const l=E?.workspaceBillingAdminPanel??null;if(!l)return(0,e.jsx)(oe,{children:(0,e.jsx)(w,{children:(0,e.jsx)(M,{title:r._({id:"R+w/Va"}),description:r._({id:"8whThc"})})})});const{stripeCustomerId:m,creditBalance:A,creditGrants:u,subscription:n,usage:_}=l,h=f=>i(f,{abbreviate:!0,decimals:2}),D=[{Icon:vt,label:r._({id:"zHJ27S"}),value:c(m)?(0,e.jsx)(xe,{path:"customers",id:m}):Ee},{Icon:Y,label:r._({id:"3hkXRB"}),value:c(A)?`${i(A,{abbreviate:!0,decimals:2})} ${r._({id:"UQ4Hjl"})}`:Ee}],k=n?.interval===Ce.Month?r._({id:"+8Nek/"}):n?.interval===Ce.Year?r._({id:"zkWmBh"}):null,p=(f,b)=>`${B(f)} → ${B(b)}`,x=c(n?.planKey)?lr(n.planKey):null,d=n?.status===I.Trialing,C=c(_)?[{Icon:We,label:r._({id:"yLljbQ"}),value:`${h(_.usedCredits)} / ${h(_.totalGrantedCredits)}`},...d?[]:[{Icon:Y,label:r._({id:"b2ghLW"}),value:h(_.grantedCredits)}],..._.rolloverCredits>0?[{Icon:Y,label:r._({id:"fqtGOd"}),value:h(_.rolloverCredits)}]:[],{Icon:ie,label:r._({id:"6SbZqO"}),value:p(_.periodStart,_.periodEnd)}]:[],F=f=>Zt({item:f,currency:n?.currency??"",formatNumber:i}),N=n?[{Icon:De,label:r._({id:"Yiplcx"}),value:(0,e.jsx)(xe,{path:"subscriptions",id:n.stripeSubscriptionId})},{Icon:bt,label:r._({id:"uAQUqI"}),value:(0,e.jsx)(W,{color:nr[n.status],children:or[n.status]})},...c(x)?[{Icon:St,label:r._({id:"GdgCoi"}),value:(0,e.jsx)(tr,{plan:x,isTrialPeriod:d})}]:[],...c(k)?[{Icon:Tt,label:r._({id:"nJGwRf"}),value:k}]:[],{Icon:ie,label:r._({id:"nSK0mT"}),value:p(n.currentPeriodStart,n.currentPeriodEnd)},...c(n.trialStart)&&c(n.trialEnd)?[{Icon:ie,label:r._({id:"67waeA"}),value:p(n.trialStart,n.trialEnd)}]:[],...n.cancelAtPeriodEnd?[{Icon:se,label:r._({id:"2CAby/"}),value:r._({id:"l75CjT"})}]:[],...c(n.cancelAt)?[{Icon:se,label:r._({id:"zbbpgB"}),value:B(n.cancelAt)}]:[],...c(n.canceledAt)?[{Icon:se,label:r._({id:"dC0BTo"}),value:B(n.canceledAt)}]:[],...n.items.map(f=>({Icon:f.productKey===de.BASE_PRODUCT?Re:f.productKey===de.RESOURCE_CREDIT?Y:ht,label:f.productName||r._({id:"a3Hy65"}),value:(0,e.jsxs)(sr,{children:[(0,e.jsx)("span",{children:F(f)}),c(f.productKey)&&(0,e.jsx)(W,{color:"gray",children:f.productKey})]})}))]:[];return(0,e.jsxs)(oe,{children:[(0,e.jsxs)(w,{children:[(0,e.jsx)(M,{title:r._({id:"876pfE"}),description:r._({id:"Zk8585"})}),(0,e.jsx)(ne,{rounded:!0,items:D,gridAutoColumns:"3fr 8fr"})]}),(0,e.jsxs)(w,{children:[(0,e.jsx)(M,{title:r._({id:"7FaY4u"}),description:c(_)?r._({id:"Woqoyp"}):r._({id:"YrBAQE"})}),c(_)&&(0,e.jsx)(ne,{rounded:!0,items:C,gridAutoColumns:"3fr 8fr"})]}),(0,e.jsxs)(w,{children:[(0,e.jsx)(M,{title:r._({id:"WVzGc2"}),description:n?r._({id:"C6vAhD"}):r._({id:"glQp+P"})}),n&&(0,e.jsx)(ne,{rounded:!0,items:N,gridAutoColumns:"3fr 8fr"})]}),(0,e.jsx)(Yt,{workspaceId:t,creditGrants:u,onGrantCreditsClick:()=>j(he)}),(0,e.jsx)(Wt,{modalInstanceId:he,workspaceId:t})]})},cr={[v.IS_APP_CLAIMING_ENABLED]:{label:{id:"gA2ZGo"},description:{id:"fWQJW/"}},[v.IS_UNIQUE_INDEXES_ENABLED]:{label:{id:"NXfWhP"},description:{id:"xfQ2i8"}},[v.IS_CONFIGURABLE_SEARCH_FIELDS_ENABLED]:{label:{id:"8/+vjg"},description:{id:"PPf/RT"}},[v.IS_JSON_FILTER_ENABLED]:{label:{id:"klrZv0"},description:{id:"G1r3UJ"}},[v.IS_MESSAGE_CAMPAIGN_ENABLED]:{label:{id:"snb/bC"},description:{id:"vs9cre"}},[v.IS_REST_METADATA_API_NEW_FORMAT_DIRECT]:{label:{id:"8n9Unw"},description:{id:"AF7Zfa"}},[v.IS_LOGIC_FUNCTION_PREBUILT_MODE_ENABLED]:{label:{id:"HslPhm"},description:{id:"8KjW3W"}},[v.IS_WORKFLOW_CORE_INDEX_PAGE_ENABLED]:{label:{id:"91e2Af"},description:{id:"40bRe+"}},[v.IS_API_RATE_LIMIT_V2_ENABLED]:{label:{id:"FXWLlg"},description:{id:"0rr3iW"}},[v.IS_MESSAGE_CALENDAR_TARGET_READ_ENABLED]:{label:{id:"jBzu2R"},description:{id:"c2ES/s"}},[v.IS_QUOTA_ENGINE_CREDIT_BOUND_ENABLED]:{label:{id:"NGOYJs"},description:{id:"+mx9eK"}},[v.IS_RECORD_CREATION_FORM_ENABLED]:{label:{id:"zod7Md"},description:{id:"MNOlLY"}},[v.IS_RECORD_SHARING_ENABLED]:{label:{id:"dmU8dH"},description:{id:"cLzEjc"}},[v.IS_WEBHOOK_RATE_LIMIT_ENABLED]:{label:{id:"0HuWgM"},description:{id:"OuYGr9"}}},pr=$`
  query GetAdminWorkspaceChatThreads($workspaceId: UUID!) {
    getAdminWorkspaceChatThreads(workspaceId: $workspaceId) {
      id
      title
      totalInputTokens
      totalOutputTokens
      conversationSize
      messageCount
      createdAt
      updatedAt
    }
  }
`,ur=$`
  fragment UserInfoFragment on UserInfo {
    id
    email
    firstName
    lastName
    createdAt
  }
`,be=$`
  ${ur}
  query WorkspaceLookupAdminPanel($workspaceId: UUID!) {
    workspaceLookupAdminPanel(workspaceId: $workspaceId) {
      user {
        ...UserInfoFragment
      }
      workspaces {
        id
        name
        allowImpersonation
        logo
        totalUsers
        activationStatus
        createdAt
        workspaceUrls {
          customUrl
          subdomainUrl
        }
        users {
          id
          email
          firstName
          lastName
          avatarUrl
        }
        featureFlags {
          key
          value
        }
      }
    }
  }
`,mr=()=>{const[t,r]=Qe(je);return{updateFeatureFlagState:(i,j,E)=>{c(t)&&t.id===i&&r({...t,featureFlags:t.featureFlags?.map(g=>g.key===j?{...g,value:E}:g)})}}},_r=Be(),Ir=()=>Ye,Ar=R(Ir())({name:"StyledFeatureFlagName",class:"slxepg4",propsAsIs:!0}),ye="settings-admin-workspace-detail-tabs",y={INFO:"info",BILLING:"billing",MEMBERS:"members",FEATURE_FLAGS:"feature-flags",CHATS:"chats"},Ta=()=>{const{workspaceId:t}=Ue(),r=Z(),s=nt(pt,ye),i=K(ot),j=K(je),E=K(lt),g=K(Et),l=E?.isBillingEnabled??!1,m=K(jt),{enqueueToast:A}=pe(),{updateFeatureFlagState:u}=mr(),{handleImpersonate:n,impersonatingUserId:_}=Ot(),[h]=ue(kt,{client:r,refetchQueries:[{query:be,variables:{workspaceId:t}}]}),{data:D,loading:k}=X(be,{client:r,variables:{workspaceId:t},skip:!t}),p=D?.workspaceLookupAdminPanel?.workspaces?.[0],x=s||y.INFO,{data:d,loading:C}=X(pr,{client:r,variables:{workspaceId:t},skip:!t||!p?.allowImpersonation||x!==y.CHATS}),{data:F}=X(yt,{client:r,variables:{workspaceIds:t?[t]:[]},skip:!t,fetchPolicy:"network-only"}),N=d?.getAdminWorkspaceChatThreads??[],f=async(a,S)=>{if(!t)return;const L=p?.featureFlags?.find(q=>q.key===a)?.value;u(t,a,S),await h({variables:{workspaceId:t,featureFlag:a,value:S},onError:q=>{c(L)&&u(t,a,L),A({variant:"error",children:`Failed to update feature flag. ${q.message}`})}})},b=[{id:y.INFO,title:o._({id:"CE+M2e"}),Icon:Ve},...l?[{id:y.BILLING,title:o._({id:"R+w/Va"}),Icon:De}]:[],...i?.canImpersonate?[{id:y.MEMBERS,title:o._({id:"wlQNTg"}),Icon:Re}]:[],...m?[{id:y.FEATURE_FLAGS,title:o._({id:"+ZqAYI"}),Icon:He}]:[],...p?.allowImpersonation?[{id:y.CHATS,title:o._({id:"8Q+lLG"}),Icon:ft}]:[]],G=p?.name||t||"",z=(0,_r.isNonEmptyString)(p?.logo)?p.logo:At,ee=(p?.featureFlags??[]).flatMap(a=>{if(!c(a.key))return[];const S=cr[a.key],L=g.find(te=>te.key===a.key)?.metadata,q=j?.id===t?j?.featureFlags?.find(te=>te.key===a.key)?.value:void 0;return[{id:a.key,label:L?.label??(c(S)?o._(S.label):a.key),description:L?.description??(c(S)?o._(S.description):""),value:q??a.value}]}),Pe=[{label:o._({id:"6YtxFj"}),overflow:"hidden",Cell:({item:a})=>(0,e.jsx)(Ar,{children:(0,e.jsx)(J,{text:(0,e.jsx)(e.Fragment,{children:a.label}),tooltipContent:a.id,tooltipPlace:Je.Top,alwaysShowTooltip:!0,isFocusable:!0})})},{label:o._({id:"Nu4oKW"}),overflow:"hidden",Cell:({item:a})=>(0,e.jsx)(J,{text:a.description,isTooltipMultiline:!0,isFocusable:!0})},{label:o._({id:"uAQUqI"}),align:"right",Cell:({item:a})=>(0,e.jsx)(et,{"aria-label":a.label,"aria-description":a.description,checked:a.value,onCheckedChange:S=>f(a.id,S)})}];return k?(0,e.jsx)(xt,{}):(0,e.jsx)(Ct,{title:G,icon:(0,e.jsx)(Ie,{src:fe(z),name:G,colorSeed:p?.id,size:"md"}),links:[{children:o._({id:"/IX/7x"}),href:ae(re.AdminPanel)},{children:o._({id:"05jO4l"}),href:Nt},{children:G}],secondaryBar:(0,e.jsx)(Dt,{tabs:b,behaveAsLinks:!1,componentInstanceId:ye}),children:(0,e.jsxs)(gt,{children:[x===y.INFO&&p&&(0,e.jsx)(Lt,{activeWorkspace:p,workspaceUpgradeStatus:F?.getUpgradeStatus?.find(a=>a?.workspaceId===t)}),x===y.BILLING&&l&&t&&(0,e.jsx)(dr,{workspaceId:t}),x===y.MEMBERS&&p&&(0,e.jsxs)(w,{children:[(0,e.jsx)(M,{title:o._({id:"wlQNTg"}),description:o._({id:"wtxjAY"})}),(0,e.jsx)(Se,{children:(0,e.jsxs)(Rt,{children:[(0,e.jsxs)(H,{gridTemplateColumns:"1fr 2fr 100px",children:[(0,e.jsx)(U,{children:o._({id:"6YtxFj"})}),(0,e.jsx)(U,{children:o._({id:"O3oNi5"})}),(0,e.jsx)(U,{align:"right",children:o._({id:"7L01XJ"})})]}),p.users?.map(a=>{const S=a.id;return c(S)?(0,e.jsxs)(H,{gridTemplateColumns:"1fr 2fr 100px",to:ae(re.AdminPanelUserDetail,{userId:S}),children:[(0,e.jsxs)(O,{color:Q.font.color.primary,gap:Q.spacing[2],overflow:"hidden",children:[(0,e.jsx)(Ie,{src:fe(a.avatarUrl),name:`${a.firstName||""} ${a.lastName||""}`.trim()||a.email,colorSeed:a.id,size:"md",shape:"circle"}),(0,e.jsx)(J,{text:`${a.firstName||""} ${a.lastName||""}`.trim()||"—"})]}),(0,e.jsx)(O,{children:a.email}),(0,e.jsx)(O,{align:"right",children:p.allowImpersonation&&c(i?.id)&&S!==i.id&&(0,e.jsx)(le,{Icon:Ke,variant:"secondary",size:"small",title:o._({id:"tSVr6t"}),onClick:L=>{L.preventDefault(),L.stopPropagation(),n(S,t)},disabled:_===S})})]},S):null})]})})]}),x===y.FEATURE_FLAGS&&p&&(0,e.jsx)(Le,{title:o._({id:"+ZqAYI"}),description:o._({id:"Dt05oz"}),gridAutoColumns:"minmax(0, 240px) minmax(0, 1fr) 56px",items:ee,columns:Pe}),x===y.CHATS&&(0,e.jsxs)(w,{children:[(0,e.jsx)(M,{title:o._({id:"jTS+KY"}),description:o._({id:"qiD/6r"})}),C?(0,e.jsx)(Ne,{}):N.length===0?(0,e.jsx)(Xe,{rounded:!0,children:(0,e.jsx)(H,{gridTemplateColumns:"1fr",children:(0,e.jsx)(O,{color:Q.font.color.tertiary,align:"center",children:o._({id:"NjIy4U"})})})}):(0,e.jsxs)(Se,{children:[(0,e.jsxs)(H,{gridTemplateColumns:"1fr 120px 120px",children:[(0,e.jsx)(U,{children:o._({id:"MHrjPM"})}),(0,e.jsx)(U,{align:"right",children:o._({id:"t7TeQU"})}),(0,e.jsx)(U,{align:"right",children:o._({id:"+b7T3G"})})]}),N.map(a=>(0,e.jsxs)(H,{gridTemplateColumns:"1fr 120px 120px",to:ae(re.AdminPanelWorkspaceChatThread,{workspaceId:t??"",threadId:a.id}),children:[(0,e.jsx)(O,{color:Q.font.color.primary,children:a.title||o._({id:"wja8aL"})}),(0,e.jsx)(O,{align:"right",children:a.messageCount}),(0,e.jsx)(O,{align:"right",children:new Date(a.updatedAt).toLocaleDateString()})]},a.id))]})]})]})})};export{Ta as SettingsAdminWorkspaceDetail};
