import {useEffect,useState} from 'react';
const key='auto-partners-text-size';
const sizes=[['normal','Звичайний','A'],['large','Великий','A+'],['largest','Дуже великий','A++']] as const;
type Size=typeof sizes[number][0];
function readSize():Size{try{const saved=localStorage.getItem(key);return sizes.some(([id])=>id===saved)?saved as Size:'normal'}catch{return 'normal'}}
function apply(size:Size){document.documentElement.dataset.textSize=size}
apply(readSize());
export default function TextSize(){
 const [size,setSize]=useState<Size>(readSize);
 useEffect(()=>{const changed=(e:StorageEvent)=>{if(e.key===key||e.key===null){const next=readSize();setSize(next);apply(next)}};window.addEventListener('storage',changed);return()=>window.removeEventListener('storage',changed)},[]);
 return <div className="text-size-tools" role="group" aria-label="Розмір тексту"><span>Розмір тексту</span>{sizes.map(([id,label,text])=><button key={id} type="button" title={label} aria-label={label+' розмір тексту'} aria-pressed={size===id} onClick={()=>{setSize(id);apply(id);try{localStorage.setItem(key,id)}catch{/* The preference still applies when storage is unavailable. */}}}>{text}</button>)}</div>
}
