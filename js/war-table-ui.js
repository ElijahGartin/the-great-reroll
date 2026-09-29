(function(){
  function closeAll(except){
    document.querySelectorAll('.wt-select.open').forEach(function(el){
      if(el !== except){
        el.classList.remove('open');
        var btn = el.querySelector('.wt-select-trigger');
        if(btn) btn.setAttribute('aria-expanded','false');
      }
    });
  }

  function enhanceSelect(select){
    if(!select || select.dataset.wtEnhanced === 'true') return;

    select.dataset.wtEnhanced = 'true';
    select.classList.add('wt-native-select');

    var wrap = document.createElement('div');
    wrap.className = 'wt-select';

    var trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.className = 'wt-select-trigger';
    trigger.setAttribute('aria-haspopup','listbox');
    trigger.setAttribute('aria-expanded','false');

    var value = document.createElement('span');
    value.className = 'wt-select-value';

    var chevron = document.createElement('span');
    chevron.className = 'wt-select-chevron';
    chevron.setAttribute('aria-hidden','true');

    trigger.appendChild(value);
    trigger.appendChild(chevron);

    var menu = document.createElement('div');
    menu.className = 'wt-select-menu';
    menu.setAttribute('role','listbox');

    function sync(){
      var selected = select.options[select.selectedIndex];
      value.textContent = selected ? selected.textContent : '';

      menu.querySelectorAll('.wt-select-option').forEach(function(optionEl){
        var isSelected = optionEl.dataset.value === select.value;
        optionEl.classList.toggle('selected', isSelected);
        optionEl.setAttribute('aria-selected', isSelected ? 'true' : 'false');
      });
    }

    Array.from(select.options).forEach(function(option){
      var item = document.createElement('button');
      item.type = 'button';
      item.className = 'wt-select-option';
      item.dataset.value = option.value;
      item.setAttribute('role','option');

      var check = document.createElement('span');
      check.className = 'wt-select-check';
      check.setAttribute('aria-hidden','true');

      var label = document.createElement('span');
      label.className = 'wt-select-option-label';
      label.textContent = option.textContent;

      item.appendChild(check);
      item.appendChild(label);

      item.addEventListener('click', function(e){
        e.preventDefault();
        select.value = option.value;
        select.dispatchEvent(new Event('input', {bubbles:true}));
        select.dispatchEvent(new Event('change', {bubbles:true}));
        sync();
        wrap.classList.remove('open');
        trigger.setAttribute('aria-expanded','false');
        trigger.focus();
      });

      menu.appendChild(item);
    });

    trigger.addEventListener('click', function(e){
      e.preventDefault();
      var opening = !wrap.classList.contains('open');
      closeAll(wrap);
      wrap.classList.toggle('open', opening);
      trigger.setAttribute('aria-expanded', opening ? 'true' : 'false');

      if(opening){
        var selectedItem = menu.querySelector('.wt-select-option.selected');
        if(selectedItem) selectedItem.scrollIntoView({block:'nearest'});
      }
    });

    trigger.addEventListener('keydown', function(e){
      var options = Array.from(menu.querySelectorAll('.wt-select-option'));
      var idx = select.selectedIndex;

      if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
        e.preventDefault();
        var next = e.key === 'ArrowDown'
          ? Math.min(options.length - 1, idx + 1)
          : Math.max(0, idx - 1);
        select.selectedIndex = next;
        select.dispatchEvent(new Event('input', {bubbles:true}));
        select.dispatchEvent(new Event('change', {bubbles:true}));
        sync();
      }

      if(e.key === 'Escape'){
        wrap.classList.remove('open');
        trigger.setAttribute('aria-expanded','false');
      }
    });

    select.addEventListener('change', sync);

    select.parentNode.insertBefore(wrap, select.nextSibling);
    wrap.appendChild(trigger);
    wrap.appendChild(menu);

    sync();
  }

  function enhanceAll(){
    document.querySelectorAll('#rerollFlow select.rr-field').forEach(enhanceSelect);
  }

  document.addEventListener('click', function(e){
    if(!e.target.closest('.wt-select')) closeAll();
  });

  document.addEventListener('keydown', function(e){
    if(e.key === 'Escape') closeAll();
  });

  if(document.readyState === 'loading'){
    document.addEventListener('DOMContentLoaded', enhanceAll);
  } else {
    enhanceAll();
  }
})();
