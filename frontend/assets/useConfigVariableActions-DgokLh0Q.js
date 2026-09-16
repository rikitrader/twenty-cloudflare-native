import{t as y}from"./isDefined-Dtu5EYqP-_d6Dqdoe.js";import{t as g}from"./lib-C3IpGLsk.js";import{t as i}from"./useMutation-Ds2Pb-th.js";import{L as C,R as p,gt as u,nf as D}from"./index-D6X3OEUa.js";import{t as V}from"./useApolloAdminClient-mk--ixl3.js";var n=g`
  query GetDatabaseConfigVariable($key: String!) {
    getDatabaseConfigVariable(key: $key) {
      name
      description
      value
      isSensitive
      isEnvOnly
      type
      options
      source
    }
  }
`,w=a=>{const t=V(),{refetch:r}=D(),[o]=i(u,{client:t}),[l]=i(C,{client:t}),[f]=i(p,{client:t}),c=async(e,b)=>{if(e===null||typeof e=="string"&&e===""||Array.isArray(e)&&e.length===0){await s();return}b?await o({variables:{key:a,value:e},refetchQueries:[{query:n,variables:{key:a}}]}):await l({variables:{key:a,value:e},refetchQueries:[{query:n,variables:{key:a}}]}),await r()},s=async e=>{y(e)&&e.preventDefault(),await f({variables:{key:a},refetchQueries:[{query:n,variables:{key:a}}]}),await r()};return{handleUpdateVariable:c,handleDeleteVariable:s}};export{n,w as t};
