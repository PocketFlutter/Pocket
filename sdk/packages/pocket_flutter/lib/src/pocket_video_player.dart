import 'dart:async';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:video_player_platform_interface/video_player_platform_interface.dart';

VideoPlayerPlatform? _lastVideoPlayerPlatform;

VideoPlayerPlatform get _videoPlayerPlatform {
  final currentInstance = VideoPlayerPlatform.instance;
  if (_lastVideoPlayerPlatform != currentInstance) {
    currentInstance.init();
    _lastVideoPlayerPlatform = currentInstance;
  }
  return currentInstance;
}

/// Pure-Dart video state backed by [VideoPlayerPlatform] so apps that do not
/// render `<Video>` never link `video_player_avfoundation` or ExoPlayer/Media3.
@immutable
final class VideoPlayerValue {
  const VideoPlayerValue({
    required this.duration,
    this.size = Size.zero,
    this.position = Duration.zero,
    this.buffered = const <DurationRange>[],
    this.isInitialized = false,
    this.isPlaying = false,
    this.isLooping = false,
    this.isBuffering = false,
    this.volume = 1.0,
    this.playbackSpeed = 1.0,
    this.rotationCorrection = 0,
    this.errorDescription,
    this.isCompleted = false,
  });

  const VideoPlayerValue.uninitialized()
    : this(duration: Duration.zero, isInitialized: false);

  const VideoPlayerValue.erroneous(String errorDescription)
    : this(
        duration: Duration.zero,
        isInitialized: false,
        errorDescription: errorDescription,
      );

  static const String _defaultErrorDescription = 'defaultErrorDescription';

  final Duration duration;
  final Size size;
  final Duration position;
  final List<DurationRange> buffered;
  final bool isInitialized;
  final bool isPlaying;
  final bool isLooping;
  final bool isBuffering;
  final double volume;
  final double playbackSpeed;
  final int rotationCorrection;
  final String? errorDescription;
  final bool isCompleted;

  bool get hasError => errorDescription != null;

  double get aspectRatio {
    if (!isInitialized || size.width == 0 || size.height == 0) return 1.0;
    final ratio = size.width / size.height;
    return ratio > 0 ? ratio : 1.0;
  }

  VideoPlayerValue copyWith({
    Duration? duration,
    Size? size,
    Duration? position,
    List<DurationRange>? buffered,
    bool? isInitialized,
    bool? isPlaying,
    bool? isLooping,
    bool? isBuffering,
    double? volume,
    double? playbackSpeed,
    int? rotationCorrection,
    String? errorDescription = _defaultErrorDescription,
    bool? isCompleted,
  }) {
    return VideoPlayerValue(
      duration: duration ?? this.duration,
      size: size ?? this.size,
      position: position ?? this.position,
      buffered: buffered ?? this.buffered,
      isInitialized: isInitialized ?? this.isInitialized,
      isPlaying: isPlaying ?? this.isPlaying,
      isLooping: isLooping ?? this.isLooping,
      isBuffering: isBuffering ?? this.isBuffering,
      volume: volume ?? this.volume,
      playbackSpeed: playbackSpeed ?? this.playbackSpeed,
      rotationCorrection: rotationCorrection ?? this.rotationCorrection,
      errorDescription: errorDescription != _defaultErrorDescription
          ? errorDescription
          : this.errorDescription,
      isCompleted: isCompleted ?? this.isCompleted,
    );
  }

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is VideoPlayerValue &&
          duration == other.duration &&
          position == other.position &&
          listEquals(buffered, other.buffered) &&
          isPlaying == other.isPlaying &&
          isLooping == other.isLooping &&
          isBuffering == other.isBuffering &&
          volume == other.volume &&
          playbackSpeed == other.playbackSpeed &&
          errorDescription == other.errorDescription &&
          size == other.size &&
          rotationCorrection == other.rotationCorrection &&
          isInitialized == other.isInitialized &&
          isCompleted == other.isCompleted;

  @override
  int get hashCode => Object.hash(
    duration,
    position,
    Object.hashAll(buffered),
    isPlaying,
    isLooping,
    isBuffering,
    volume,
    playbackSpeed,
    errorDescription,
    size,
    rotationCorrection,
    isInitialized,
    isCompleted,
  );
}

/// On-demand platform video controller that talks directly to
/// [VideoPlayerPlatform.instance] without pulling native codecs unless the
/// consuming app opts into `package:video_player`.
class VideoPlayerController extends ValueNotifier<VideoPlayerValue> {
  VideoPlayerController.asset(
    this.dataSource, {
    this.package,
    this.viewType = VideoViewType.textureView,
  }) : dataSourceType = DataSourceType.asset,
       httpHeaders = const <String, String>{},
       super(const VideoPlayerValue.uninitialized());

  VideoPlayerController.file(
    File file, {
    this.httpHeaders = const <String, String>{},
    this.viewType = VideoViewType.textureView,
  }) : dataSource = Uri.file(file.absolute.path).toString(),
       dataSourceType = DataSourceType.file,
       package = null,
       super(const VideoPlayerValue.uninitialized());

  final String dataSource;
  final DataSourceType dataSourceType;
  final String? package;
  final Map<String, String> httpHeaders;
  final VideoViewType viewType;

  static const int kUninitializedPlayerId = -1;
  int _playerId = kUninitializedPlayerId;
  int get playerId => _playerId;

  Timer? _timer;
  bool _isDisposed = false;
  Completer<void>? _creatingCompleter;
  StreamSubscription<VideoEvent>? _eventSubscription;

  bool get _isDisposedOrNotInitialized => _isDisposed || !value.isInitialized;

  Future<void> initialize() async {
    _creatingCompleter = Completer<void>();
    final DataSource description = switch (dataSourceType) {
      DataSourceType.asset => DataSource(
        sourceType: DataSourceType.asset,
        asset: dataSource,
        package: package,
      ),
      DataSourceType.file => DataSource(
        sourceType: DataSourceType.file,
        uri: dataSource,
        httpHeaders: httpHeaders,
      ),
      DataSourceType.network => DataSource(
        sourceType: DataSourceType.network,
        uri: dataSource,
        httpHeaders: httpHeaders,
      ),
      DataSourceType.contentUri => DataSource(
        sourceType: DataSourceType.contentUri,
        uri: dataSource,
      ),
    };

    try {
      _playerId =
          (await _videoPlayerPlatform.createWithOptions(
            VideoCreationOptions(dataSource: description, viewType: viewType),
          )) ??
          kUninitializedPlayerId;
    } finally {
      if (!_creatingCompleter!.isCompleted) {
        _creatingCompleter!.complete(null);
      }
    }

    final initializingCompleter = Completer<void>();

    void eventListener(VideoEvent event) {
      if (_isDisposed) return;
      switch (event.eventType) {
        case VideoEventType.initialized:
          value = value.copyWith(
            duration: event.duration,
            size: event.size,
            rotationCorrection: event.rotationCorrection,
            isInitialized: event.duration != null,
            errorDescription: null,
            isCompleted: false,
          );
          if (initializingCompleter.isCompleted) {
            throw StateError('VideoPlayerController already initialized');
          }
          initializingCompleter.complete(null);
          unawaited(_applyLooping());
          unawaited(_applyVolume());
          unawaited(_applyPlayPause());
        case VideoEventType.completed:
          pause().then((_) => seekTo(value.duration));
          value = value.copyWith(isCompleted: true);
        case VideoEventType.bufferingUpdate:
          value = value.copyWith(buffered: event.buffered);
        case VideoEventType.bufferingStart:
          value = value.copyWith(isBuffering: true);
        case VideoEventType.bufferingEnd:
          value = value.copyWith(isBuffering: false);
        case VideoEventType.isPlayingStateUpdate:
          if (event.isPlaying ?? false) {
            value = value.copyWith(
              isPlaying: event.isPlaying,
              isCompleted: false,
            );
          } else {
            value = value.copyWith(isPlaying: event.isPlaying);
          }
        case VideoEventType.unknown:
          break;
      }
    }

    void errorListener(Object error) {
      final message = error is PlatformException
          ? (error.message ?? error.code)
          : '$error';
      value = VideoPlayerValue.erroneous(message);
      _timer?.cancel();
      if (!initializingCompleter.isCompleted) {
        initializingCompleter.completeError(error);
      }
    }

    _eventSubscription = _videoPlayerPlatform
        .videoEventsFor(_playerId)
        .listen(eventListener, onError: errorListener);
    return initializingCompleter.future;
  }

  @override
  Future<void> dispose() async {
    if (_isDisposed) return;
    if (_creatingCompleter != null) {
      await _creatingCompleter!.future;
      if (!_isDisposed) {
        _isDisposed = true;
        _timer?.cancel();
        await _eventSubscription?.cancel();
        if (_playerId != kUninitializedPlayerId) {
          await _videoPlayerPlatform.dispose(_playerId);
        }
      }
    }
    _isDisposed = true;
    super.dispose();
  }

  Future<void> play() async {
    if (value.position == value.duration) {
      await seekTo(Duration.zero);
    }
    value = value.copyWith(isPlaying: true);
    await _applyPlayPause();
  }

  Future<void> pause() async {
    value = value.copyWith(isPlaying: false);
    await _applyPlayPause();
  }

  Future<void> setLooping(bool looping) async {
    value = value.copyWith(isLooping: looping);
    await _applyLooping();
  }

  Future<void> setVolume(double volume) async {
    value = value.copyWith(volume: volume.clamp(0.0, 1.0));
    await _applyVolume();
  }

  Future<Duration?> get position async {
    if (_isDisposed || _playerId == kUninitializedPlayerId) return null;
    return _videoPlayerPlatform.getPosition(_playerId);
  }

  Future<void> seekTo(Duration position) async {
    if (_isDisposedOrNotInitialized) return;
    if (position > value.duration) {
      position = value.duration;
    } else if (position < Duration.zero) {
      position = Duration.zero;
    }
    await _videoPlayerPlatform.seekTo(_playerId, position);
    _updatePosition(position);
  }

  Future<void> _applyLooping() async {
    if (_isDisposedOrNotInitialized) return;
    await _videoPlayerPlatform.setLooping(_playerId, value.isLooping);
  }

  Future<void> _applyVolume() async {
    if (_isDisposedOrNotInitialized) return;
    await _videoPlayerPlatform.setVolume(_playerId, value.volume);
  }

  Future<void> _applyPlayPause() async {
    if (_isDisposedOrNotInitialized) return;
    if (value.isPlaying) {
      await _videoPlayerPlatform.play(_playerId);
      _timer?.cancel();
      _timer = Timer.periodic(const Duration(milliseconds: 100), (_) async {
        if (_isDisposed) return;
        final next = await position;
        if (next != null) _updatePosition(next);
      });
      if (!_isDisposedOrNotInitialized && value.isPlaying) {
        await _videoPlayerPlatform.setPlaybackSpeed(
          _playerId,
          value.playbackSpeed,
        );
      }
    } else {
      _timer?.cancel();
      await _videoPlayerPlatform.pause(_playerId);
    }
  }

  void _updatePosition(Duration next) {
    if (next > value.duration) next = value.duration;
    value = value.copyWith(
      position: next,
      isCompleted: next == value.duration,
    );
  }

  @override
  void removeListener(VoidCallback listener) {
    if (!_isDisposed) super.removeListener(listener);
  }
}

class VideoPlayer extends StatefulWidget {
  const VideoPlayer(this.controller, {super.key});

  final VideoPlayerController controller;

  @override
  State<VideoPlayer> createState() => _VideoPlayerState();
}

class _VideoPlayerState extends State<VideoPlayer> {
  late int _playerId;

  void _onControllerChanged() {
    final nextId = widget.controller.playerId;
    if (nextId != _playerId) {
      setState(() => _playerId = nextId);
    }
  }

  @override
  void initState() {
    super.initState();
    _playerId = widget.controller.playerId;
    widget.controller.addListener(_onControllerChanged);
  }

  @override
  void didUpdateWidget(covariant VideoPlayer oldWidget) {
    super.didUpdateWidget(oldWidget);
    oldWidget.controller.removeListener(_onControllerChanged);
    _playerId = widget.controller.playerId;
    widget.controller.addListener(_onControllerChanged);
  }

  @override
  void dispose() {
    widget.controller.removeListener(_onControllerChanged);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_playerId == VideoPlayerController.kUninitializedPlayerId) {
      return const SizedBox.shrink();
    }
    final view = _videoPlayerPlatform.buildViewWithOptions(
      VideoViewOptions(playerId: _playerId),
    );
    final rotation = widget.controller.value.rotationCorrection;
    if (rotation == 0 || rotation % 90 != 0) return view;
    return RotatedBox(quarterTurns: rotation ~/ 90, child: view);
  }
}
