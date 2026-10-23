import type {CarApproval} from './approval';
import { z } from 'zod';
export const statuses={planned:'Заплановано',bought:'Придбано',preparing:'Підготовка',selling:'У продажу',sold:'Продано'} as const;
const amount=z.number().finite().min(0).max(10000000).transform(n=>Math.round(n*100)/100);
const date=z.string().refine(s=>s===''||(/^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(Date.parse(s))), 'Перевір дату');
export const carInput=z.object({make:z.string().trim().min(1,'Вкажи марку').max(80),model:z.string().trim().min(1,'Вкажи модель').max(120),
 year:z.number().int().min(1900).max(2027).nullable(),engine:z.string().max(40),gearbox:z.string().max(40),color:z.string().max(50),
 purchase:amount,expenses:amount,minimum:amount,target:amount,actual:amount.nullable(),boughtAt:date,sellBy:date,status:z.enum(['planned','bought','preparing','selling','sold']),notes:z.string().max(5000),
 photos:z.array(z.string().max(160000).regex(/^data:image\/(?:jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/,'Некоректний формат фото')).max(6,'Максимум 6 фотографій').optional(),
 url:z.string().max(2000).refine(s=>s===''||/^https?:\/\//i.test(s),'Посилання має починатися з https://'),
}).refine(c=>c.target>=c.minimum,{message:'Цільова ціна має бути не нижчою за мінімальну',path:['target']})
 .refine(c=>c.status!=='sold'||c.actual!==null,{message:'Вкажи фактичну ціну продажу',path:['actual']});
export type CarInput=z.input<typeof carInput>;
export type Car=CarInput & {actualExpenses?:number;expenseCount?:number;approval?:CarApproval;id:string;version:number;createdAt:string;updatedAt:string;updatedBy:string;createdBy:string};
export type Message={id:string;carId:string|null;body:string;authorId:string;authorName:string;createdAt:string};
export const money=(n:number)=>new Intl.NumberFormat('uk-UA',{style:'currency',currency:'EUR',minimumFractionDigits:0,maximumFractionDigits:2}).format(n);
export const actualExpenses=(c:CarInput&{actualExpenses?:number})=>c.actualExpenses??0;
export const costExpenses=(c:CarInput&{actualExpenses?:number})=>c.actualExpenses===undefined?c.expenses:c.status==='sold'?c.actualExpenses:Math.max(c.expenses,c.actualExpenses);
export const profit=(c:CarInput&{actualExpenses?:number},price=c.target)=>Math.round((price-c.purchase-costExpenses(c))*100)/100;
export const blankCar:CarInput={make:'',model:'',year:null,engine:'',gearbox:'',color:'',purchase:0,expenses:0,minimum:0,target:0,actual:null,boughtAt:'',sellBy:'',status:'planned',notes:'',url:''};
