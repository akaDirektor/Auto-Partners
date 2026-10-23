import {z} from 'zod';
export const expenseInput=z.object({id:z.string().uuid(),carId:z.string().uuid(),amount:z.number().finite().positive().max(10000000).transform(n=>Math.round(n*100)/100).refine(n=>n>0),date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s=>{const d=new Date(s+'T12:00:00Z');return !Number.isNaN(+d)&&d.toISOString().slice(0,10)===s},'Перевір дату.'),note:z.string().trim().min(1).max(1000)});
export type ExpenseInput=z.input<typeof expenseInput>;
export type ExpenseEntry=ExpenseInput&{version:number;authorName:string;createdAt:string};
export const expenseTotal=(entries:ExpenseEntry[])=>entries.reduce((n,e)=>n+Math.round(e.amount*100),0)/100;
