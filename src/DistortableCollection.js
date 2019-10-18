L.DistortableCollection = L.FeatureGroup.extend({
  options: {
    editable: true,
  },

  initialize: function(options) {
    L.setOptions(this, options);
    L.FeatureGroup.prototype.initialize.call(this, options);

    this.editable = this.options.editable;
  },

  onAdd: function(map) {
    L.FeatureGroup.prototype.onAdd.call(this, map);

    this._map = map;

    if (this.editable) { this.editing.enable(); }

    /**
     * although we have a DistortableCollection.Edit class that handles collection events to keep our code managable,
     * events that need to be added on individual images are kept here to do so through `layeradd`.
     */
    this.on('layeradd', this._addEvents, this);
    this.on('layerremove', this._removeEvents, this);
  },

  onRemove: function() {
    if (this.editing) { this.editing.disable(); }

    this.off('layeradd', this._addEvents, this);
    this.off('layerremove', this._removeEvents, this);
  },

  _addEvents: function(e) {
    var layer = e.layer;

    L.DomEvent.on(layer, {
      dragstart: this._dragStartMultiple,
      drag: this._dragMultiple,
    }, this);

    L.DomEvent.on(layer._image, {
      mousedown: this._deselectOthers,
      /* Enable longpress for multi select for touch devices. */
      contextmenu: this._longPressMultiSelect,
    }, this);
  },

  _removeEvents: function(e) {
    var layer = e.layer;

    L.DomEvent.off(layer, {
      dragstart: this._dragStartMultiple,
      drag: this._dragMultiple,
    }, this);

    L.DomEvent.off(layer._image, {
      mousedown: this._deselectOthers,
      contextmenu: this._longPressMultiSelect,
    }, this);
  },

  _longPressMultiSelect: function(e) {
    if (!this.editable) { return; }

    e.preventDefault();

    this.eachLayer(function(layer) {
      var edit = layer.editing;
      if (layer.getElement() === e.target && edit.enabled()) {
        L.DomUtil.toggleClass(layer.getElement(), 'collected');
        if (this.anyCollected()) {
          layer.deselect();
          this.editing._addToolbar();
        } else {
          this.editing._removeToolbar();
        }
      }
    }, this);
  },

  isCollected: function(overlay) {
    return L.DomUtil.hasClass(overlay.getElement(), 'collected');
  },

  anyCollected: function() {
    var layerArr = this.getLayers();
    return layerArr.some(this.isCollected.bind(this));
  },

  _toggleCollected: function(e, layer) {
    if (e.shiftKey) {
      /** conditional prevents disabled images from flickering multi-select mode */
      if (layer.editing.enabled()) {
        L.DomUtil.toggleClass(e.target, 'collected');
      }
    }

    if (this.anyCollected()) { layer.deselect(); }
    else { this.editing._removeToolbar(); }
  },

  _deselectOthers: function(e) {
    if (!this.editable) { return; }

    this.eachLayer(function(layer) {
      if (layer.getElement() !== e.target) {
        layer.deselect();
      } else {
        this._toggleCollected(e, layer);
      }
    }, this);

    if (e) { L.DomEvent.stopPropagation(e); }
  },

  _dragStartMultiple: function(e) {
    var overlay = e.target;
    var map = this._map;
    var i;

    if (!this.isCollected(overlay)) { return; }

    this.eachLayer(function(layer) {
      layer._dragStartPoints = {};
      layer.deselect();
      for (i = 0; i < 4; i++) {
        var c = layer.getCorner(i);
        layer._dragStartPoints[i] = map.latLngToLayerPoint(c);
      }
    });
  },

  _dragMultiple: function(e) {
    var overlay = e.target;
    var map = this._map;

    if (!this.isCollected(overlay)) { return; }

    var topLeft = map.latLngToLayerPoint(overlay.getCorner(0));
    var delta = overlay._dragStartPoints[0].subtract(topLeft);

    this._updateCollectionFromPoints(delta, overlay);
  },

  _toRemove: function() {
    var layerArr = this.getLayers();

    return layerArr.filter(function(layer) {
      var mode = layer.editing._mode;
      return (this.isCollected(layer) && mode !== 'lock');
    }, this);
  },

  _toMove: function(overlay) {
    var layerArr = this.getLayers();

    return layerArr.filter(function(layer) {
      var mode = layer.editing._mode;
      return layer !== overlay && this.isCollected(layer) && mode !== 'lock';
    }, this);
  },

  _updateCollectionFromPoints: function(delta, overlay) {
    var layersToMove = this._toMove(overlay);
    var p = new L.Transformation(1, -delta.x, 1, -delta.y);
    var i;

    layersToMove.forEach(function(layer) {
      var movedPoints = {};
      for (i = 0; i < 4; i++) {
        movedPoints[i] = p.transform(layer._dragStartPoints[i]);
      }
      layer.setCornersFromPoints(movedPoints);
    });
  },

  _getAvgCmPerPixel: function(imgs) {
    var reduce = imgs.reduce(function(sum, img) {
      return sum + img.cm_per_pixel;
    }, 0);
    return reduce / imgs.length;
  },

  generateExportJson: function() {
    var json = {};
    json.images = [];

    this.eachLayer(function(layer) {
      if (this.isCollected(layer)) {
        var sections = layer._image.src.split('/');
        var filename = sections[sections.length-1];
        var zc = layer.getCorners();
        var corners = [
          {lat: zc[0].lat, lon: zc[0].lng},
          {lat: zc[1].lat, lon: zc[1].lng},
          {lat: zc[3].lat, lon: zc[3].lng},
          {lat: zc[2].lat, lon: zc[2].lng},
        ];
        json.images.push({
          id: this.getLayerId(layer),
          src: layer._image.src,
          width: layer._image.width,
          height: layer._image.height,
          image_file_name: filename,
          nodes: corners,
          cm_per_pixel: L.ImageUtil.getCmPerPixel(layer),
        });
      }
    }, this);

    json.images = json.images.reverse();
    json.avg_cm_per_pixel = this._getAvgCmPerPixel(json.images);

    return json;
  },

  startExport: function(opts) {
    opts = opts || {};
    opts.collection = opts.collection || this.generateExportJson();
    opts.frequency = opts.frequency || 3000;
    opts.scale = opts.scale || 100; // switch it to _getAvgCmPerPixel !
    var statusUrl, updateInterval;

    // this may be overridden to update the UI to show export progress or completion
    function _defaultUpdater(data) {
      data = JSON.parse(data);
      // optimization: fetch status directly from google storage:
      if (statusUrl !== data.status_url && data.status_url.match('.json')) { statusUrl = data.status_url; }
      if (data.status === "complete") {
        clearInterval(updateInterval);
      }
      if (data.status === 'complete' && data.jpg !== null) {
        alert("Export succeeded. http://export.mapknitter.org/" + data.jpg);
      }
      // TODO: update to clearInterval when status == "failed" if we update that in this file:
      // https://github.com/publiclab/mapknitter-exporter/blob/main/lib/mapknitterExporter.rb
      console.log(data);
    }

    // receives the URL of status.json, and starts running the updater to repeatedly fetch from status.json; 
    // this may be overridden to integrate with any UI
    function _defaultHandleStatusUrl(data) {
      console.log(data);
      statusUrl = "//export.mapknitter.org" + data; // bust cache with timestamp
      opts.updater = opts.updater || _defaultUpdater;

      // repeatedly fetch the status.json
      updateInterval = setInterval(function intervalUpdater() {
        $.ajax(statusUrl + "?" + Date.now(), { // bust cache with timestamp
          type: "GET",
          crossDomain: true
        }).done(function(data) {
            opts.updater(data);
        });
      }, opts.frequency);
    }

    function _fetchStatusUrl(collection, scale) {
      opts.handleStatusUrl = opts.handleStatusUrl || _defaultHandleStatusUrl;

      $.ajax({
        url: "//export.mapknitter.org/export",
        crossDomain: true,
        type: "POST",
        data: {
          collection: JSON.stringify(collection.images),
          scale: scale
        },
        success: opts.handleStatusUrl // this handles the initial response
      });
    }

    _fetchStatusUrl(opts.collection, opts.scale);

  }

});

L.distortableCollection = function(id, options) {
  return new L.DistortableCollection(id, options);
};
