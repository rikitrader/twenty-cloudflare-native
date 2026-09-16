import{i as f,z as o}from"./types-B1Nl-NC7-CP3NR7BC.js";import{t as a}from"./isDefined-Dtu5EYqP-_d6Dqdoe.js";import{C as $,at as y,nt as R}from"./utils-Cz7Ljo6y-CFEmid-V.js";import{Yt as E}from"./graphql-CBCbBFnA.js";import{t as d}from"./isUndefinedOrNull-BgCnd9uY.js";import{n as l}from"./useObjectPermissions-Dp91OTFW.js";import{t as C}from"./isNonCompositeField-CbIPOIgY.js";var T=t=>t.type===E.MORPH_RELATION,_=t=>t.type===o.MORPH_RELATION?(t.morphRelations??[]).map(e=>$({fieldName:t.name,relationType:e.type,targetObjectMetadataNameSingular:e.targetObjectMetadata.nameSingular,targetObjectMetadataNamePlural:e.targetObjectMetadata.namePlural})):[y({name:t.name})],b=({objectMetadataItems:t,gqlField:e,fieldMetadata:n,relationRecordGqlFields:O,computeReferences:u=!1,objectPermissionsByObjectMetadataId:m})=>{const s=n.type;if(C(s))return e;if(s===o.MORPH_RELATION&&(n.settings?.relationType===f.ONE_TO_MANY||n.settings?.relationType===f.MANY_TO_ONE)){let p="";for(const r of n.morphRelations??[]){const i=R({fieldName:n.name,relationType:n.settings?.relationType,targetObjectMetadataNameSingular:r.targetObjectMetadata.nameSingular,targetObjectMetadataNamePlural:r.targetObjectMetadata.namePlural}),N=t.find(L=>L.id===r.targetObjectMetadata.id);if(a(N)){if(a(m)&&a(N.id)){if(!a(r.targetObjectMetadata.id))throw new Error(`Target object metadata id not found with field metadata ${n.name}`);if(!l(m,r.targetObjectMetadata.id).canReadObjectRecords)continue}if(n.settings?.relationType===f.ONE_TO_MANY){if(e!==i)continue;p+=`${i}
{
  edges {
    node ${c({objectMetadataItems:t,objectMetadataItem:N,recordGqlFields:O,computeReferences:u,isRootLevel:!1,objectPermissionsByObjectMetadataId:m})}
  }
}`}if(n.settings?.relationType===f.MANY_TO_ONE){if(e===`${i}Id`){p+=`${e}
    `;continue}if(e!==i)continue;p+=`${i}
${c({objectMetadataItems:t,objectMetadataItem:N,recordGqlFields:O,computeReferences:u,isRootLevel:!1,objectPermissionsByObjectMetadataId:m})}`}}}return`${p}`}if(s===o.RELATION&&n.relation?.type===f.MANY_TO_ONE){const p=t.find(r=>r.id===n.relation?.targetObjectMetadata.id);if(!a(p))return"";if(a(m)&&a(p.id)){if(!a(n.relation?.targetObjectMetadata.id))throw new Error(`Target object metadata id not found with field metadata ${n.name}`);if(!l(m,n.relation?.targetObjectMetadata.id).canReadObjectRecords)return""}return e===y({name:n.name})?`${e}`:`${e}
${c({objectMetadataItems:t,objectMetadataItem:p,recordGqlFields:O,computeReferences:u,isRootLevel:!1,objectPermissionsByObjectMetadataId:m})}`}if(s===o.RELATION&&n.relation?.type===f.ONE_TO_MANY){const p=t.find(r=>r.id===n.relation?.targetObjectMetadata.id);if(!a(p))return"";if(a(m)&&a(p.id)){if(!a(n.relation?.targetObjectMetadata.id))throw new Error(`Target object metadata id not found with field metadata ${n.name}`);if(!l(m,n.relation?.targetObjectMetadata.id).canReadObjectRecords)return""}return`${e}
{
  edges {
    node ${c({objectMetadataItems:t,objectMetadataItem:p,recordGqlFields:O,computeReferences:u,isRootLevel:!1,objectPermissionsByObjectMetadataId:m})}
  }
}`}return s===o.LINKS?`${e}
{
  primaryLinkUrl
  primaryLinkLabel
  secondaryLinks {
    label
    url
  }
}`:s===o.CURRENCY?`${e}
{
  amountMicros
  currencyCode
}
    `:s===o.FULL_NAME?`${e}
{
  firstName
  lastName
}`:s===o.ADDRESS?`${e}
{
  addressStreet1
  addressStreet2
  addressCity
  addressState
  addressCountry
  addressPostcode
  addressLat
  addressLng
}`:s===o.ACTOR?`${e}
{
    source
    workspaceMemberId
    name
    context {
      provider
    }
}`:s===o.EMAILS?`${e}
{
  primaryEmail
  additionalEmails
}`:s===o.PHONES?`${e}
    {
      primaryPhoneNumber
      primaryPhoneCountryCode
      primaryPhoneCallingCode
      additionalPhones {
        number
        callingCode
        countryCode
      }
    }`:s===o.FILES?`${e}
    {
      fileId
      label
      extension
      url
    }`:s===o.RICH_TEXT?`${e}
{
  blocknote
  markdown
}`:""},g=t=>t.type===E.RELATION,h=({gqlField:t,fieldMetadata:e,recordGqlFields:n})=>{const O=(g(e)||T(e))&&_(e).includes(t);return!!(d(n)&&!g(e)&&!T(e)||d(n)&&O||a(n)&&a(n[t])&&n[t]!==!1)},S=t=>a(t)&&typeof t=="object"&&t!==null&&!Array.isArray(t),c=({objectMetadataItems:t,objectMetadataItem:e,recordGqlFields:n,computeReferences:O=!1,isRootLevel:u=!0,objectPermissionsByObjectMetadataId:m})=>{if(!u&&a(m)&&a(e.id)&&!l(m,e.id).canReadObjectRecords)return"";const s=(e?.readableFields.filter(r=>r.isActive).filter(r=>r.type===o.RELATION?r.relation?.type===f.MANY_TO_ONE:r.type===o.MORPH_RELATION?r.settings?.relationType===f.MANY_TO_ONE:!1)).flatMap(r=>_(r).map(i=>({gqlField:i,fieldMetadata:r}))),p=[...e.readableFields.filter(r=>r.isActive).flatMap(r=>r.type!==o.MORPH_RELATION?[{gqlField:r.name,fieldMetadata:r}]:a(r.morphRelations)?r.morphRelations.map(i=>({gqlField:R({fieldName:r.name,relationType:i.type,targetObjectMetadataNameSingular:i.targetObjectMetadata.nameSingular,targetObjectMetadataNamePlural:i.targetObjectMetadata.namePlural}),fieldMetadata:r})):[]),...s].sort((r,i)=>r.gqlField.localeCompare(i.gqlField)).filter(r=>h({gqlField:r.gqlField,fieldMetadata:r.fieldMetadata,recordGqlFields:n}));return!u&&O?`{
      __ref
    }`:`{
__typename
${p.map(r=>{const i=n?.[r.gqlField],N=S(i)?i:void 0;return b({objectMetadataItems:t,gqlField:r.gqlField,fieldMetadata:r.fieldMetadata,relationRecordGqlFields:N,computeReferences:O,objectPermissionsByObjectMetadataId:m})}).filter(r=>r!=="").join(`
`)}
}`},w=({recordConnection:t})=>t?.edges?.map(e=>A({recordNode:e.node})),A=({recordNode:t})=>{const{id:e,__typename:n}=t;return{...Object.fromEntries(Object.entries(t).map(([O,u])=>d(u)||Array.isArray(u)||typeof u!="object"?[O,u]:a(u.edges)?[O,w({recordConnection:u})]:[O,A({recordNode:u})])),...a(e)?{id:e}:{},...a(n)?{__typename:n}:{}}};export{_ as a,g as i,w as n,T as o,c as r,A as t};
