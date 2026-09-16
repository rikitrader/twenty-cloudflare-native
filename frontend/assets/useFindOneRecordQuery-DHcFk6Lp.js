import{o as s}from"./chunk-ChpBd9eV.js";import{t as i}from"./react-M6yZRsSc.js";import{Cr as c}from"./utils-Cz7Ljo6y-CFEmid-V.js";import{t as d}from"./useAtomStateValue-Dh9Tkqi-.js";import{n}from"./lib-C3IpGLsk.js";import{t as u}from"./objectMetadataItemsSelector-Dzn2nS_x.js";import{t as p}from"./useObjectPermissions-Dp91OTFW.js";import{r as f}from"./getRecordFromRecordNode-DbeyRbcx.js";import{t as b}from"./useObjectMetadataItem-D0VhxnJ6.js";var j=s(i(),1),R=({objectNameSingular:m,recordGqlFields:e,withSoftDeleted:r=!1})=>{const{objectMetadataItem:t}=b({objectNameSingular:m}),a=d(u),{objectPermissionsByObjectMetadataId:o}=p();return{findOneRecordQuery:(0,j.useMemo)(()=>n`
      query FindOne${c(t.nameSingular)}($objectRecordId: UUID!) {
        ${t.nameSingular}(filter: {
        ${r?`
          or: [
            { deletedAt: { is: NULL } },
            { deletedAt: { is: NOT_NULL } }
          ],
        `:""}
          id: {
            eq: $objectRecordId
          }
        })${f({objectMetadataItems:a,objectMetadataItem:t,recordGqlFields:e,objectPermissionsByObjectMetadataId:o})}
      },
  `,[t,a,e,r,o])}};export{R as t};
