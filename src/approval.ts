export type CarApproval={revision:number;approved:boolean;signatures:{userId:string;name:string;role:'owner'|'partner';createdAt:string}[]};
export const proposalFields=['make','model','year','engine','gearbox','color','purchase','expenses','minimum','target','boughtAt','sellBy'] as const;
export function sameProposal(a:Record<string,unknown>,b:Record<string,unknown>){return proposalFields.every(k=>a[k]===b[k])}
export const proposalSnapshot=(p:Record<string,unknown>)=>Object.fromEntries(proposalFields.map(k=>[k,p[k]]));
