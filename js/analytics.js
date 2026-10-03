(()=>{
  const config={
    provider:'umami',
    // Activation: replace this placeholder with wowwartable.com's Umami Website ID.
    // See README.md: Analytics activation. Do not paste an API key here.
    websiteId:'PASTE_UMAMI_WEBSITE_ID_HERE',
    scriptUrl:'https://cloud.umami.is/script.js',
    domains:'wowwartable.com'
  };
  window.GR_ANALYTICS_CONFIG=config;
  // Only the public HTTPS host may load Umami or queue/send events.
  const isPublicSite=window.location.protocol==='https:' &&
    window.location.hostname===config.domains && !window.location.port;
  const enabled=isPublicSite && config.websiteId && !config.websiteId.startsWith('PASTE_');
  const queue=[];
  window.grTrack=function(name,data){
    if(!enabled) return;
    const payload=data||{};
    if(window.umami && typeof window.umami.track==='function'){
      try{ window.umami.track(name,payload); }catch(e){}
    }else{
      queue.push([name,payload]);
    }
  };
  if(!enabled) return;
  const el=document.createElement('script');
  el.defer=true;
  el.src=config.scriptUrl;
  el.setAttribute('data-website-id',config.websiteId);
  el.setAttribute('data-domains',config.domains);
  el.setAttribute('data-exclude-search','true');
  el.onload=()=>{
    if(!(window.umami && typeof window.umami.track==='function')) return;
    while(queue.length){ const [name,data]=queue.shift(); try{window.umami.track(name,data)}catch(e){} }
  };
  document.head.appendChild(el);
})();
