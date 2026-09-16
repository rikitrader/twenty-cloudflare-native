import{t as z}from"./jsx-runtime-BmDUFisN.js";import{u as L}from"./types-B1Nl-NC7-CP3NR7BC.js";import{t as f}from"./dist-x6yBUqMs.js";import{t as W}from"./build-CngeiE9P.js";import{s as q}from"./theme-constants-CTjFR_ac-BSZx2FmI.js";import{t as l}from"./isDefined-Dtu5EYqP-_d6Dqdoe.js";import{En as Q,gn as O}from"./utils-Cz7Ljo6y-CFEmid-V.js";import{t as $}from"./createAtomState-CIJqqZRg.js";import{t}from"./dist-Cg5OofxW.js";import{i as X}from"./IconSquareRoundedCheck-_QjQzihg.js";import{t as Z}from"./IconDotsVertical-B8pBwOxf.js";import{t as V}from"./IconSparkles-DuCLe6KO.js";import{t as k}from"./useAtomState-t25i5gHy.js";import{S as j}from"./data-display-gKsNeQfV-DA6XVR-8.js";import{i as _}from"./OverflowingTextWithTooltip-DPuVU_BH-DfeYl9fg.js";import{E as Y,n as J}from"./input-BtFIK2kq-CYLkBJQm.js";import{m as E}from"./navigation-DmAyQWOY-CSzgEVVE.js";import{r as K}from"./layout-GaTEE2ty-BAr5SYLm.js";import{t as ee}from"./typography-0W7dTJd5-cWdtERIZ.js";import{i as re}from"./feedback-B8qCrrXa-BQNdimoS.js";import{t as te}from"./index.module-BcHbo21h.js";import{t as ae}from"./lib-C3IpGLsk.js";import{t as se}from"./useQuery-klx7Id1G.js";import{t as ie}from"./useAtomFamilyStateValue-DpWKflfw.js";import{t as oe}from"./Dropdown-CRJSi42h.js";import{t as ne}from"./Table-B46Zylx7.js";import{t as i}from"./TableCell-DSca9vGY.js";import{t as c}from"./TableHeader-BNrAkiaI.js";import{t as R}from"./TableRow-C8DgeYyl.js";import{n as de,t as le}from"./DropdownMenuItemsContainer-DyyPfdpm.js";import{D as d,E as v,T as M,Xp as me,cl as he,dl as ce}from"./index-D6X3OEUa.js";import{t as pe}from"./useApolloAdminClient-mk--ixl3.js";import{t as fe}from"./TableBody-DIvn_7WK.js";import{n as ue,t as b}from"./SortableTableHeader-oE6ADUXp.js";import{t as I}from"./SettingsEmptyPlaceholder-CepdMhQZ.js";import{t as ge}from"./AiAdminPath-CNhUEtqy.js";var e=z(),B="1fr 1fr 1fr 80px 80px 110px 90px",p="settings-admin-chats-table",D=W(),ye=f("div")({name:"StyledFlagsContainer",class:"s18clrs0",propsAsIs:!1}),Ce=f("span")({name:"StyledZeroReplies",class:"s1vygaax",propsAsIs:!1}),Se=({thread:r})=>(0,e.jsxs)(R,{to:Q(L.AdminPanelWorkspaceChatThread,{workspaceId:r.workspaceId,threadId:r.id}),gridAutoColumns:B,isClickable:!0,children:[(0,e.jsx)(i,{minWidth:"0",overflow:"hidden",children:(0,e.jsx)(_,{text:(0,D.isNonEmptyString)(r.workspaceDisplayName)?r.workspaceDisplayName:r.workspaceId})}),(0,e.jsx)(i,{minWidth:"0",overflow:"hidden",children:(0,e.jsx)(_,{text:(0,D.isNonEmptyString)(r.userEmail)?r.userEmail:"-"})}),(0,e.jsx)(i,{color:q.font.color.primary,minWidth:"0",overflow:"hidden",children:(0,e.jsx)(_,{text:(0,D.isNonEmptyString)(r.title)?r.title:t._({id:"wja8aL"})})}),(0,e.jsx)(i,{align:"right",children:r.messageCount}),(0,e.jsx)(i,{align:"right",children:r.userReplyCount===0?(0,e.jsx)(Ce,{children:r.userReplyCount}):r.userReplyCount}),(0,e.jsx)(i,{minWidth:"0",overflow:"hidden",children:(0,e.jsxs)(ye,{children:[r.hasError&&(0,e.jsx)(j,{color:"red",children:t._({id:"SlfejT"})}),l(r.deletedAt)&&(0,e.jsx)(j,{color:"gray",children:t._({id:"TdfEV7"})}),r.isOnboardingThread&&(0,e.jsx)(j,{color:"blue",children:t._({id:"gukxZ5"})})]})}),(0,e.jsx)(i,{align:"right",children:new Date(r.createdAt).toLocaleDateString()})]}),Ae=({threads:r})=>(0,e.jsxs)(ne,{children:[(0,e.jsxs)(R,{gridAutoColumns:B,children:[(0,e.jsx)(c,{children:t._({id:"pmUArF"})}),(0,e.jsx)(c,{children:t._({id:"7PzzBU"})}),(0,e.jsx)(c,{children:t._({id:"MHrjPM"})}),(0,e.jsx)(b,{tableId:p,fieldName:d.MESSAGE_COUNT,label:t._({id:"XXzjfC"}),align:"right"}),(0,e.jsx)(b,{tableId:p,fieldName:d.REPLY_COUNT,label:t._({id:"N8UzTV"}),align:"right"}),(0,e.jsx)(c,{children:t._({id:"Xgkhyj"})}),(0,e.jsx)(b,{tableId:p,fieldName:d.CREATED_AT,label:t._({id:"d+F6q9"}),align:"right",initialSort:{fieldName:d.CREATED_AT,direction:"desc"}})]}),(0,e.jsx)(fe,{children:r.map(a=>(0,e.jsx)(Se,{thread:a},a.id))})]}),Te=f("div")({name:"StyledTableContainer",class:"sglm1yl",propsAsIs:!1}),xe=({threads:r,loading:a,error:s})=>l(s)?(0,e.jsx)(I,{children:t._({id:"UYDPfv"})}):a&&!O(r)?(0,e.jsx)(I,{children:t._({id:"UDL15Z"})}):O(r)?(0,e.jsx)(Te,{children:(0,e.jsx)(Ae,{threads:r})}):(0,e.jsx)(I,{children:t._({id:"nU13WY"})}),je=({filterButton:r,filters:a,onFiltersChange:s})=>(0,e.jsx)(oe,{dropdownId:"settings-admin-chats-filter-dropdown",dropdownPlacement:"bottom-end",dropdownOffset:{x:0,y:8},clickableComponent:r,dropdownComponents:(0,e.jsx)(de,{children:(0,e.jsxs)(le,{children:[(0,e.jsx)(E,{LeftIcon:V,onCheckedChange:()=>s({...a,onboardingOnly:!a.onboardingOnly}),checked:a.onboardingOnly,text:t._({id:"uahNQ+"}),size:"sm"}),(0,e.jsx)(E,{LeftIcon:X,onCheckedChange:()=>s({...a,hasErrorOnly:!a.hasErrorOnly}),checked:a.hasErrorOnly,text:t._({id:"fQoUMw"}),size:"sm"}),(0,e.jsx)(E,{LeftIcon:me,onCheckedChange:()=>s({...a,userNeverEngagedOnly:!a.userNeverEngagedOnly}),checked:a.userNeverEngagedOnly,text:t._({id:"ywC9IM"}),size:"sm"})]})})}),_e={onboardingOnly:!1,hasErrorOnly:!1,userNeverEngagedOnly:!1},Ee=$({key:"adminChatsFilterState",defaultValue:_e}),ve=$({key:"adminChatsSearchQueryState",defaultValue:""}),be=r=>Object.values(d).includes(r),Ie=r=>!l(r)||!be(r.fieldName)?{sortBy:d.CREATED_AT,sortDirection:v.DESC}:{sortBy:r.fieldName,sortDirection:r.direction==="asc"?v.ASC:v.DESC},De=ae`
  query GetAdminChatThreads(
    $scope: AdminChatThreadScope
    $hasErrorOnly: Boolean
    $userNeverEngagedOnly: Boolean
    $searchTerm: String
    $sortBy: AdminChatThreadSortField
    $sortDirection: AdminChatThreadSortDirection
    $limit: Int
    $offset: Int
  ) {
    getAdminChatThreads(
      scope: $scope
      hasErrorOnly: $hasErrorOnly
      userNeverEngagedOnly: $userNeverEngagedOnly
      searchTerm: $searchTerm
      sortBy: $sortBy
      sortDirection: $sortDirection
      limit: $limit
      offset: $offset
    ) {
      totalCount
      hasMore
      threads {
        id
        title
        workspaceId
        workspaceDisplayName
        userWorkspaceId
        userEmail
        userFirstName
        userLastName
        messageCount
        userReplyCount
        hasError
        isOnboardingThread
        deletedAt
        createdAt
        updatedAt
      }
    }
  }
`,F=25,we=()=>{const r=pe(),{enqueueToast:a}=re(),[s,u]=k(ve),[m]=te(s,300),[o,g]=k(Ee),{sortBy:y,sortDirection:C}=Ie(ie(ue,{tableId:p})),{data:n,loading:h,error:S,fetchMore:P}=se(De,{client:r,notifyOnNetworkStatusChange:!0,variables:{limit:F,offset:0,searchTerm:m,scope:o.onboardingOnly?M.ONBOARDING:M.ALL,hasErrorOnly:o.hasErrorOnly,userNeverEngagedOnly:o.userNeverEngagedOnly,sortBy:y,sortDirection:C}}),w=n?.getAdminChatThreads.threads??[],U=n?.getAdminChatThreads.totalCount??0,G=n?.getAdminChatThreads.hasMore??!1,N=h||s!==m;return{searchQuery:s,setSearchQuery:u,filters:o,setFilters:g,threads:w,totalCount:U,hasMore:G,loading:h,isShowMoreDisabled:N,error:S,handleShowMore:async()=>{if(!N)try{await P({variables:{limit:F,offset:w.length},updateQuery:(A,{fetchMoreResult:T})=>{if(!l(T))return A;const H=new Set(A.getAdminChatThreads.threads.map(x=>x.id));return{getAdminChatThreads:{...T.getAdminChatThreads,threads:[...A.getAdminChatThreads.threads,...T.getAdminChatThreads.threads.filter(x=>!H.has(x.id))]}}}})}catch{a({variant:"error",children:t._({id:"HYRl4P"})})}}}},Ne=f("div")({name:"StyledShowMoreContainer",class:"s2ap62f",propsAsIs:!1}),ur=()=>{const{searchQuery:r,setSearchQuery:a,filters:s,setFilters:u,threads:m,totalCount:o,hasMore:g,loading:y,isShowMoreDisabled:C,error:n,handleShowMore:h}=we();return(0,e.jsx)(ce,{links:[{children:t._({id:"/IX/7x"}),href:Q(L.AdminPanel)},{children:t._({id:"05jO4l"}),href:ge},{children:t._({id:"8Q+lLG"})}],children:(0,e.jsx)(he,{children:(0,e.jsxs)(K,{children:[(0,e.jsx)(ee,{title:t._({id:"8Q+lLG"}),description:t._({id:"041SWy",values:{totalCount:o}})}),(0,e.jsx)(Y,{placeholder:t._({id:"MS72xQ"}),value:r,onChange:a,filterDropdown:S=>(0,e.jsx)(je,{filterButton:S,filters:s,onFiltersChange:u})}),(0,e.jsx)(xe,{threads:m,loading:y,error:n}),g&&!l(n)&&(0,e.jsx)(Ne,{children:(0,e.jsx)(J,{title:t._({id:"fMPkxb"}),Icon:Z,onClick:h,disabled:C,size:"small",variant:"secondary"})})]})})})};export{ur as SettingsAdminChats};
