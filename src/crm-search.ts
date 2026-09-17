import type { Env } from './types';
import { crmRecords, crmSearchAuthorization } from './crm-records';

type Row = Record<string, any>;
const objects = [
  {name:'person',plural:'people',table:'contacts',label:"first_name || ' ' || last_name",extra:'email',title:'Person'},
  {name:'company',plural:'companies',table:'companies',label:'name',extra:'domain',title:'Company'},
  {name:'opportunity',plural:'opportunities',table:'opportunities',label:'name',extra:'stage',title:'Opportunity'},
  {name:'activity',plural:'activities',table:'activities',label:'title',extra:'body',title:'Activity'},
];
const cap=(text:string)=>text[0].toUpperCase()+text.slice(1);
const failure=(message:string,status=400)=>Response.json({errors:[{message}]},{status});

/** Generated combined relation-picker query and global command-menu search. */
export async function crmSearch(op:string,query:string,vars:Row,env:Env,workspaceId:string,role:string,subject:string):Promise<Response|null> {
  if(op!=='Search' && op!=='CombinedFindManyRecords') return null;
  if(op==='CombinedFindManyRecords') {
    const selected=objects.filter(object=>new RegExp(`\\b${object.plural}\\s*\\(`).test(query));
    if(!selected.length) return failure('No supported objects in combined record query');
    const data:Row={};
    for(const object of selected) {
      const suffix=cap(object.name);
      const variables=Object.fromEntries(['filter','orderBy','after','before','first','last'].map(key=>[key,vars[`${key}${suffix}`]]));
      const response=await crmRecords(`FindMany${cap(object.plural)}`,`query FindMany${cap(object.plural)} { ${object.plural} { edges { node { id } } } }`,variables,env,workspaceId,role,subject);
      if(!response) return failure('Combined record query is unavailable',500);
      const body=await response.json() as Row;
      if(!response.ok || body.errors) return Response.json(body,{status:response.status});
      Object.assign(data,body.data);
    }
    return Response.json({data});
  }
  if(typeof vars.searchInput!=='string' || vars.searchInput.length>200) return failure('Search input must be a string of at most 200 characters');
  const limit=Number(vars.limit??20);
  if(!Number.isInteger(limit)||limit<1||limit>100) return failure('Search limit must be 1–100');
  const include=vars.includedObjectNameSingulars??[],exclude=vars.excludedObjectNameSingulars??[];
  if(!Array.isArray(include)||!Array.isArray(exclude)||include.length>100||exclude.length>100) return failure('Invalid search object selection');
  const candidates=objects.filter(object=>(!include.length||include.includes(object.name))&&!exclude.includes(object.name));
  const selected=[] as Array<(typeof objects)[number] & {rowSql:string;rowParams:Array<string|number|null>;searchLabel:boolean;searchExtra:boolean}>;
  for(const candidate of candidates) {
    const authorization=await crmSearchAuthorization(env,workspaceId,role,candidate.name,subject);
    if(!authorization.allowed) continue;
    const labelFields=candidate.name==='person'?['name','firstName','lastName']:[candidate.label];
    const searchLabel=labelFields.every(field=>!authorization.readDenied.has(field));
    const searchExtra=!authorization.readDenied.has(candidate.extra);
    // A search result must have a readable label. Never substitute a hidden
    // field or leak its existence through matching behavior.
    if(!searchLabel) continue;
    selected.push({...candidate,rowSql:authorization.rowSql,rowParams:authorization.rowParams,searchLabel,searchExtra});
  }
  if(candidates.length&&!selected.length) return failure('Read access denied',403);
  const params:unknown[]=[];
  const pattern=`%${vars.searchInput.replace(/[\\%_]/g,(char:string)=>`\\${char}`)}%`;
  function filter(value:unknown,depth=0):string {
    if(value==null) return '1=1';
    if(typeof value!=='object'||Array.isArray(value)||depth>8||params.length>70) throw new Error('Invalid search filter');
    const clauses:string[]=[];
    for(const [key,condition] of Object.entries(value)) {
      if(key==='and'||key==='or') {
        if(!Array.isArray(condition)||condition.length>20) throw new Error('Invalid search filter group');
        clauses.push(condition.length?`(${condition.map(item=>filter(item,depth+1)).join(key==='and'?' AND ':' OR ')})`:key==='and'?'1=1':'0=1'); continue;
      }
      if(key==='not') {clauses.push(`NOT (${filter(condition,depth+1)})`);continue;}
      const column=({id:'id',createdAt:'created_at',updatedAt:'updated_at',deletedAt:'deleted_at'} as Row)[key];
      if(!column||!condition||typeof condition!=='object'||Array.isArray(condition)) throw new Error('Invalid search filter field');
      for(const [operator,operand] of Object.entries(condition)) {
        if(operator==='is' && (operand==='NULL'||operand==='NOT_NULL')) {clauses.push(`${column} IS ${operand==='NULL'?'':'NOT '}NULL`);continue;}
        if(operator==='in' && Array.isArray(operand)&&operand.length<=50&&operand.every(x=>typeof x==='string')) {
          clauses.push(operand.length?`${column} IN (${operand.map(()=>'?').join(',')})`:'0=1');params.push(...operand);continue;
        }
        const sqlOperator=({eq:'=',neq:'<>',gt:'>',gte:'>=',lt:'<',lte:'<='} as Row)[operator];
        if(!sqlOperator||typeof operand!=='string') throw new Error('Invalid search filter operator');
        clauses.push(`${column} ${sqlOperator} ?`);params.push(operand);
      }
    }
    return clauses.length?clauses.join(' AND '):'1=1';
  }
  try {
    const filterClause=filter(vars.filter);
    const filterParams=[...params];params.length=0;
    const selects=selected.map(object=>{
      const searchable=[`(${object.label}) LIKE ? ESCAPE '\\'`];
      params.push(workspaceId,pattern);
      if(object.searchExtra) { searchable.push(`${object.extra} LIKE ? ESCAPE '\\'`); params.push(pattern); }
      params.push(...filterParams,...object.rowParams);
      return `SELECT id AS recordId, '${object.name}' AS objectNameSingular, '${object.title}' AS objectLabelSingular, ${object.label} AS label, NULL AS imageUrl FROM ${object.table} WHERE workspace_id=? AND deleted_at IS NULL AND (${searchable.join(' OR ')}) AND (${filterClause}) AND (${object.rowSql})`;
    });
    let cursorClause='';
    if(vars.after) {
      const cursor=JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(String(vars.after)),char=>char.charCodeAt(0))));
      if(!Array.isArray(cursor)||cursor.length!==3||!cursor.every(x=>typeof x==='string'&&x.length<1000)) return failure('Invalid search cursor');
      cursorClause='WHERE (lower(label),objectNameSingular,recordId) > (?,?,?)';params.push(...cursor);
    }
    if(params.length>95) return failure('Search filter exceeds D1 binding budget');
    const rows=selected.length?(await env.CRM_DB!.prepare(`SELECT *,lower(label) AS sortKey FROM (${selects.join(' UNION ALL ')}) ${cursorClause} ORDER BY lower(label),objectNameSingular,recordId LIMIT ?`).bind(...params,limit+1).all<Row>()).results:[];
    const cursor=(row:Row)=>btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify([row.sortKey,row.objectNameSingular,row.recordId]))));
    const nodes=rows.slice(0,limit);
    return Response.json({data:{search:{__typename:'SearchConnection',edges:nodes.map(row=>({__typename:'SearchEdge',node:{__typename:'SearchRecord',recordId:row.recordId,objectNameSingular:row.objectNameSingular,objectLabelSingular:row.objectLabelSingular,label:row.label,imageUrl:null,tsRank:0,tsRankCD:0},cursor:cursor(row)})),pageInfo:{__typename:'PageInfo',hasNextPage:rows.length>limit,endCursor:nodes.length?cursor(nodes[nodes.length-1]):null}}}});
  } catch(error) {
    if(error instanceof SyntaxError||error instanceof DOMException||error instanceof Error && error.message.startsWith('Invalid search')) return failure('Invalid search filter or cursor');
    throw error;
  }
}
