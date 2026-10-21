export const MAX_PHOTOS=6;
export const MAX_PHOTO_LENGTH=160000;
export async function preparePhoto(file:File):Promise<string>{
 if(!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error('Обери JPEG, PNG або WebP. Для HEIC спочатку експортуй фото в JPEG.');
 if(file.size>20*1024*1024)throw Error('Одне фото має бути не більше 20 МБ.');
 const url=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(Error('Не вдалося прочитати фото.'));reader.readAsDataURL(file)});
 try{
  const img=new Image();img.src=url;await img.decode().catch(()=>{throw Error('Не вдалося відкрити фото. Обери інший JPEG, PNG або WebP.')});
  const scale=Math.min(1,1200/Math.max(img.naturalWidth,img.naturalHeight));
  let width=Math.round(img.naturalWidth*scale),height=Math.round(img.naturalHeight*scale);
  const canvas=document.createElement('canvas');const ctx=canvas.getContext('2d');if(!ctx)throw Error('Не вдалося обробити фото.');
  for(let attempt=0;attempt<8;attempt++){
   canvas.width=Math.max(1,width);canvas.height=Math.max(1,height);ctx.fillStyle='#fff';ctx.fillRect(0,0,width,height);ctx.drawImage(img,0,0,width,height);
   const data=canvas.toDataURL('image/jpeg',Math.max(.45,.82-attempt*.05));if(data.length<=MAX_PHOTO_LENGTH)return data;
   width=Math.round(width*.8);height=Math.round(height*.8);
  }
  throw Error('Не вдалося зменшити фото. Обери інший файл.');
 }finally{URL.revokeObjectURL(url)}
}
