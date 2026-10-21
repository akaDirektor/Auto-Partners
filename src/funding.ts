import {z} from 'zod';
export const fundingInput=z.object({
 id:z.string().uuid(),kind:z.enum(['funding','repayment']),
 amount:z.number().finite().positive().max(10000000).transform(n=>Math.round(n*100)/100).refine(n=>n>0),
 date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T12:00:00Z');return !Number.isNaN(+d)&&d.toISOString().slice(0,10)===s},'Перевір дату.'),
 note:z.string().trim().max(1000),
});
export type FundingInput=z.input<typeof fundingInput>;
export type FundingEntry=FundingInput&{authorName:string;createdAt:string};
export function fundingTotals(entries:FundingEntry[]){let funded=0,repaid=0;for(const e of entries){const cents=Math.round(e.amount*100);if(e.kind==='funding')funded+=cents;else repaid+=cents}return {funded:funded/100,repaid:repaid/100,outstanding:(funded-repaid)/100}}
